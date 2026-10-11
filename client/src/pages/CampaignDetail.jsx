import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ClipboardCheck, Send, Sparkles, Trash2, UserPlus } from 'lucide-react';
import { del, get, patch, post, qs, useLoad, waitForJob } from '../api.js';
import {
  Alert, Badge, Button, Card, Checkbox, Empty, ErrorAlert, Input, PageHeader, Progress, Select, Spinner, StatusBadge, cx, fmtDate, useToast,
} from '../components/ui.jsx';
import { CampaignForm } from './Campaigns.jsx';

function Recipients({ campaign, onAdded }) {
  const toast = useToast();
  const [filters, setFilters] = useState({ q: '', sheet: '', minScore: '', includeIneligible: '', freeDomain: '' });
  const [selected, setSelected] = useState(new Set());
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const { data: facets } = useLoad(() => get('/recruiters/facets'));
  const { data, loading, reload } = useLoad(
    () => get(`/campaigns/${campaign.id}/candidates${qs({ ...filters, pageSize: 200 })}`),
    [campaign.id, JSON.stringify(filters)],
  );
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const selectable = (data?.items || []).filter((r) => !r.blockers.length && !r.inCampaign);
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const needsOverride = [...selected].some((id) => data?.items.find((r) => r.id === id)?.warnings.some((w) => w.startsWith('Already contacted')));

  async function add() {
    setBusy(true);
    try {
      const r = await post(`/campaigns/${campaign.id}/recipients`, { recruiterIds: [...selected], overrideReason: override });
      setResult(r);
      setSelected(new Set());
      toast(`${r.added} recipients added`);
      reload();
      onAdded();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Search…" value={filters.q} onChange={(e) => set('q', e.target.value)} className="w-60" />
          <Select value={filters.sheet} onChange={(e) => set('sheet', e.target.value)} options={[{ value: '', label: 'All sheets' }, ...(facets?.sheets || []).map((s) => ({ value: s.value, label: `${s.name} (${s.count})` }))]} />
          <Select value={filters.minScore} onChange={(e) => set('minScore', e.target.value)} options={[{ value: '', label: 'Any score' }, { value: 60, label: 'Score ≥ 60' }, { value: 75, label: 'Score ≥ 75' }, { value: 90, label: 'Score ≥ 90' }]} />
          <Select value={filters.freeDomain} onChange={(e) => set('freeDomain', e.target.value)} options={[{ value: '', label: 'Any email domain' }, { value: 'false', label: 'Corporate domains only' }]} />
          <Checkbox label="Show ineligible / already added" checked={filters.includeIneligible === 'true'} onChange={(v) => set('includeIneligible', v ? 'true' : '')} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setSelected(new Set(selectable.slice(0, 10).map((r) => r.id)))}>Select top 10</Button>
          <Button size="sm" onClick={() => setSelected(new Set(selectable.slice(0, 25).map((r) => r.id)))}>Top 25</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          <span className="text-sm text-slate-500">{selected.size} selected · {data?.total ?? 0} matching</span>
          {needsOverride && (
            <Input placeholder="Reason for contacting again (required)" value={override} onChange={(e) => setOverride(e.target.value)} className="w-72" />
          )}
          <Button variant="primary" icon={UserPlus} disabled={!selected.size || (needsOverride && !override.trim())} loading={busy} onClick={add} className="ml-auto">
            Add {selected.size || ''} to campaign
          </Button>
        </div>
        {result?.skipped?.length > 0 && (
          <Alert kind="warning" className="mt-3" title={`${result.skipped.length} not added`}>
            <ul className="list-disc pl-4 text-xs">
              {result.skipped.slice(0, 10).map((s) => <li key={s.id}>{s.name}: {s.reason}</li>)}
            </ul>
          </Alert>
        )}
      </Card>
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : !data?.items.length ? (
          <Empty title="No eligible contacts">Adjust filters, or import contacts first.</Empty>
        ) : (
          <div className="scroll-thin max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Contact</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((r) => {
                  const disabled = r.blockers.length > 0 || r.inCampaign;
                  return (
                    <tr key={r.id} className={cx(disabled ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50')} onClick={() => !disabled && toggle(r.id)}>
                      <td className="px-3 py-2">
                        <input type="checkbox" disabled={disabled} checked={selected.has(r.id)} readOnly />
                      </td>
                      <td className="px-3 py-2">
                        <Badge color={r.score >= 80 ? 'green' : r.score >= 60 ? 'yellow' : 'gray'}>{r.score}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium">{r.name || '—'}</p>
                        <p className="text-xs text-slate-500">{r.email} {r.designation && `· ${r.designation}`}</p>
                      </td>
                      <td className="px-3 py-2">
                        <p>{r.company || '—'}</p>
                        <p className="max-w-[220px] truncate text-xs text-slate-500">{r.job_roles}</p>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.inCampaign && <Badge color="indigo">in campaign</Badge>}
                        {r.blockers.map((b) => <Badge key={b} color="red" className="mr-1">{b}</Badge>)}
                        {r.warnings.map((w) => <Badge key={w} color="yellow" className="mr-1">{w}</Badge>)}
                        <ul className="text-slate-500">
                          {r.reasons.filter((x) => x.points !== 0).slice(0, 4).map((x) => (
                            <li key={x.reason}>
                              <span className={x.points > 0 ? 'text-emerald-600' : 'text-rose-600'}>{x.points > 0 ? `+${x.points}` : x.points}</span> {x.reason}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Emails({ campaign, onChanged }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [job, setJob] = useState(null);
  const { data: drafts, reload } = useLoad(() => get(`/drafts${qs({ campaignId: campaign.id, status })}`), [campaign.id, status]);
  const queued = campaign.stats.byStatus.queued || 0;

  async function generate(draftIds) {
    try {
      const j = await post(`/campaigns/${campaign.id}/generate`, { draftIds });
      setJob(j);
      const done = await waitForJob(j.id, (x) => { setJob(x); reload(); });
      setJob(null);
      toast(done.failed ? `${done.total - done.failed} drafts generated, ${done.failed} failed: ${done.errors[0]}` : `${done.total} drafts generated. Review them next.`, done.failed ? 'error' : 'success');
      reload();
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[{ value: '', label: 'All statuses' }, ...['queued', 'draft', 'approved', 'sent', 'failed', 'skipped', 'rejected'].map((s) => ({ value: s, label: s === 'draft' ? 'needs review' : s }))]}
          />
          <Button variant="primary" icon={Sparkles} disabled={!queued || !!job} onClick={() => generate([])}>
            Generate {queued} queued draft{queued === 1 ? '' : 's'}
          </Button>
          <Link to={`/review?campaignId=${campaign.id}`}>
            <Button icon={ClipboardCheck}>Open review queue</Button>
          </Link>
        </div>
        {job && <div className="mt-3"><Progress value={job.done} total={job.total} label="Generating with Gemini (company research runs first when enabled)" /></div>}
      </Card>
      <Card padded={false}>
        {!drafts ? (
          <Spinner />
        ) : !drafts.length ? (
          <Empty title="No emails yet">Add recipients first, then generate drafts.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {drafts.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2">
                    <p className="font-medium">{d.recruiter_name || d.to_email}</p>
                    <p className="text-xs text-slate-500">{d.recruiter_company} · {d.to_email}</p>
                  </td>
                  <td className="max-w-md px-3 py-2">
                    <Link to={`/review?campaignId=${campaign.id}&draft=${d.id}`} className="text-indigo-600 hover:underline">
                      {d.kind === 'follow_up' && <Badge color="purple" className="mr-1">follow-up</Badge>}
                      {d.subject || <span className="text-slate-400">(not generated)</span>}
                    </Link>
                    {d.generation_error && <p className="text-xs text-rose-600">{d.generation_error}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <StatusBadge status={d.status} />
                      {d.errors > 0 && <Badge color="red">{d.errors} issue</Badge>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {['queued', 'draft', 'skipped', 'rejected'].includes(d.status) && (
                      <Button size="sm" variant="ghost" icon={Trash2} title="Remove from campaign" onClick={async () => { await del(`/drafts/${d.id}`); reload(); onChanged(); }} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function SendStep({ campaign }) {
  const navigate = useNavigate();
  const { data, loading, reload } = useLoad(() => get(`/campaigns/${campaign.id}/send-preview`), [campaign.id]);
  const [excluded, setExcluded] = useState(new Set());
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const ids = useMemo(() => (data?.ready || []).filter((d) => !excluded.has(d.id)).map((d) => d.id), [data, excluded]);
  const phrase = `SEND ${ids.length}`;
  const remaining = data ? Math.max(0, data.dailyLimit - data.sentLast24h) : 0;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const { batchId } = await post(`/campaigns/${campaign.id}/send`, { draftIds: ids, confirmCount: ids.length, confirmText: typed });
      navigate(`/sending/${batchId}`);
    } catch (err) {
      setError(err);
      reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Spinner />;
  return (
    <div className="space-y-4">
      {!data.gmail && <Alert kind="warning" title="Gmail is not connected">Connect it on the <Link className="underline" to="/settings">Settings</Link> page before sending.</Alert>}
      {data.unknownAttempts > 0 && (
        <Alert kind="warning" title={`${data.unknownAttempts} earlier send(s) have an unknown outcome`}>
          Reconcile them on the <Link className="underline" to="/sending">Sending</Link> page first; they are excluded until checked against Gmail.
        </Alert>
      )}
      <Card title={`Final confirmation · ${ids.length} email${ids.length === 1 ? '' : 's'} ready`}>
        <p className="mb-3 text-sm text-slate-600">
          Only individually approved emails whose content still matches the approval are listed. Emails go out one by one, about every{' '}
          {data.delaySeconds}s. Daily limit: {data.dailyLimit} ({remaining} remaining in the last 24 hours).
        </p>
        {ids.length > remaining && <Alert kind="warning" className="mb-3">Only {remaining} can go out now; the batch pauses at the daily limit and you can resume later.</Alert>}
        {data.ready.length === 0 ? (
          <Empty title="Nothing approved yet">Approve drafts in the review queue.</Empty>
        ) : (
          <table className="mb-4 w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {data.ready.map((d) => (
                <tr key={d.id} className={excluded.has(d.id) ? 'opacity-40' : ''}>
                  <td className="w-8 py-1.5">
                    <input type="checkbox" checked={!excluded.has(d.id)} onChange={() => setExcluded((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })} />
                  </td>
                  <td className="py-1.5">
                    <span className="font-medium">{d.name || d.to}</span> <span className="text-slate-500">&lt;{d.to}&gt; · {d.company}</span>
                  </td>
                  <td className="py-1.5 text-slate-700">{d.subject}</td>
                  <td className="py-1.5 text-xs text-slate-500">{d.attachment ? `📎 ${d.attachment}` : 'in thread'}</td>
                  <td className="py-1.5">{d.status === 'failed' ? <Badge color="red">retry</Badge> : <Badge color="green">approved {fmtDate(d.approvedAt)}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ids.length > 0 && (
          <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <Checkbox checked={checked} onChange={setChecked} label={`I reviewed each of these ${ids.length} emails and want them sent individually from my Gmail account.`} />
            <div className="flex items-center gap-2">
              <Input placeholder={`Type ${phrase} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} className="w-56" />
              <Button variant="success" icon={Send} disabled={!checked || typed.trim().toUpperCase() !== phrase || !data.gmail} loading={busy} onClick={send}>
                Send {ids.length} email{ids.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
        <ErrorAlert error={error} />
      </Card>
      {data.blocked.length > 0 && (
        <Card title={`Blocked (${data.blocked.length})`}>
          <ul className="space-y-1 text-sm">
            {data.blocked.map((d) => (
              <li key={d.id}>
                <Link to={`/review?draft=${d.id}`} className="font-medium text-indigo-600">{d.name || d.to}</Link>{' '}
                <span className="text-rose-700">{d.reasons.join('; ')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const toast = useToast();
  const [tab, setTab] = useState('recipients');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { data, reload } = useLoad(async () => {
    const [campaign, resumes] = await Promise.all([get(`/campaigns/${id}`), get('/resumes')]);
    return { campaign, resumes };
  }, [id]);
  if (!data) return <Spinner />;
  const { campaign } = data;
  const s = campaign.stats.byStatus;
  const tabs = [
    ['recipients', 'Recipients'],
    ['emails', `Emails (${campaign.stats.total})`],
    ['send', `Send (${(s.approved || 0) + (s.failed || 0)})`],
    ['settings', 'Settings'],
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={campaign.name}
        subtitle={`${campaign.resume?.label || 'No resume'} · ${campaign.style} · follow up after ${campaign.followup_days} days (max ${campaign.max_followups})`}
        actions={
          <div className="flex gap-1.5">
            {['queued', 'draft', 'approved', 'sent', 'failed'].map((k) => s[k] ? <span key={k}><StatusBadge status={k} /> {s[k]}</span> : null)}
            {campaign.stats.replies > 0 && <Badge color="green">{campaign.stats.replies} replies</Badge>}
          </div>
        }
      />
      {!campaign.resume && <Alert kind="warning">Choose a resume in Settings before adding recipients.</Alert>}
      <div className="flex gap-1 border-b border-slate-200">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cx('-mb-px border-b-2 px-4 py-2 text-sm', tab === k ? 'border-indigo-600 font-medium text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'recipients' && <Recipients campaign={campaign} onAdded={reload} />}
      {tab === 'emails' && <Emails campaign={campaign} onChanged={reload} />}
      {tab === 'send' && <SendStep campaign={campaign} />}
      {tab === 'settings' && (
        <Card>
          <ErrorAlert error={error} />
          <CampaignForm
            initial={campaign}
            resumes={data.resumes}
            busy={busy}
            submitLabel="Save settings"
            onSubmit={async (v) => {
              setBusy(true);
              setError(null);
              try {
                await patch(`/campaigns/${campaign.id}`, v);
                toast('Campaign updated');
                reload();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          />
          <p className="mt-3 text-xs text-slate-500">Changing the resume affects drafts generated from now on; existing drafts keep the resume they were generated with.</p>
        </Card>
      )}
    </div>
  );
}
