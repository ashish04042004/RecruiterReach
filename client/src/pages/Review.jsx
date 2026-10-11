import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ClipboardCheck, Mail, Paperclip, RotateCcw, Save, SkipForward, Sparkles, Undo2, X } from 'lucide-react';
import { get, patch, post, qs, useLoad } from '../api.js';
import {
  Alert, Badge, Button, Card, Empty, ErrorAlert, Input, Select, Spinner, StatusBadge, Textarea, cx, fmtDate, useToast,
} from '../components/ui.jsx';

function DraftEditor({ draftId, onChanged, onNext }) {
  const toast = useToast();
  const { data, error, reload, setData } = useLoad(() => get(`/drafts/${draftId}`), [draftId]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  useEffect(() => {
    if (data) {
      setSubject(data.draft.subject || '');
      setBody(data.draft.body || '');
      setActionError(null);
    }
  }, [data]);

  const d = data?.draft;
  const dirty = !!d && (subject !== (d.subject || '') || body !== (d.body || ''));
  const locked = d && ['sending', 'sent', 'unknown'].includes(d.status);

  const act = useCallback(
    async (name, fn, { advance } = {}) => {
      setBusy(name);
      setActionError(null);
      try {
        const result = await fn();
        if (result?.draft) setData(result);
        onChanged();
        if (advance) onNext();
        return result;
      } catch (err) {
        setActionError(err);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [onChanged, onNext, setData],
  );

  const save = () => act('save', () => patch(`/drafts/${draftId}`, { subject, body, baseVersion: d.version }));
  const approve = () =>
    act('approve', async () => {
      let current = data;
      if (dirty) current = await patch(`/drafts/${draftId}`, { subject, body, baseVersion: d.version });
      const r = await post(`/drafts/${draftId}/approve`, { version: current.draft.version });
      toast(`Approved v${r.draft.version}`);
      return r;
    }, { advance: true });

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 's') {
        e.preventDefault();
        if (dirty && !locked) save();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!locked && d && ['draft', 'failed'].includes(d.status)) approve();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Spinner />;
  const { recruiter, campaign, resume, approval, company, parent } = data;
  const quality = d.quality || [];
  const p = d.personalization || {};
  const words = body.split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <Card padded={false}>
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={d.status} />
              {d.kind === 'follow_up' && <Badge color="purple">follow-up #{d.followup_number}</Badge>}
              <span className="text-xs text-slate-500">v{d.version} · {campaign?.name}</span>
            </div>
            <div className="text-xs">
              {approval.valid ? (
                <Badge color="green">Approved v{approval.version} · {fmtDate(approval.approvedAt)}</Badge>
              ) : d.status !== 'queued' && approval.reason !== 'Not approved' ? (
                <Badge color="yellow">{approval.reason}</Badge>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-[70px_1fr] items-center gap-y-1.5 text-sm">
            <span className="text-slate-500">To</span>
            <span>
              <span className="font-medium">{recruiter?.name || '(no name)'}</span> &lt;{d.to_email}&gt;
              <span className="text-slate-500"> · {recruiter?.designation ? `${recruiter.designation}, ` : ''}{recruiter?.company}</span>
            </span>
            <span className="text-slate-500">Subject</span>
            <Input value={subject} disabled={locked || d.status === 'queued'} onChange={(e) => setSubject(e.target.value)} />
            <span className="text-slate-500">Attach</span>
            <span className="flex items-center gap-1.5 text-sm">
              {d.kind === 'follow_up' ? (
                <span className="text-slate-500">Sent as a reply in the original thread (resume already attached there)</span>
              ) : resume ? (
                <a className="flex items-center gap-1 text-indigo-600 hover:underline" href={`/api/resumes/${resume.id}/file`} target="_blank" rel="noreferrer">
                  <Paperclip className="h-3.5 w-3.5" /> {d.attachment_name || resume.originalFilename}
                  <span className="text-xs text-slate-400">({resume.label}, sha {resume.fileHash.slice(0, 8)})</span>
                </a>
              ) : (
                <span className="text-rose-600">missing</span>
              )}
            </span>
          </div>
        </div>
        <div className="p-4">
          {d.status === 'queued' ? (
            <Empty icon={Sparkles} title="Not generated yet">
              <Button variant="primary" icon={Sparkles} loading={busy === 'generate'} onClick={() => act('generate', () => post(`/drafts/${draftId}/generate`))}>
                Generate this draft
              </Button>
            </Empty>
          ) : (
            <>
              <Textarea value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} rows={16} className="font-[inherit] leading-relaxed" />
              <p className="mt-1 text-right text-xs text-slate-400">{words} words{dirty ? ' · unsaved changes' : ''}</p>
            </>
          )}
          {d.generation_error && <Alert kind="error" className="mt-2" title="Generation failed">{d.generation_error}</Alert>}
        </div>
      </Card>

      <ErrorAlert error={actionError} />
      {dirty && approval.valid && <Alert kind="warning">Saving these edits will invalidate the current approval. You'll need to approve the new version.</Alert>}

      {!locked && d.status !== 'queued' && (
        <div className="flex flex-wrap items-center gap-2">
          {['draft', 'failed'].includes(d.status) && (
            <Button variant="success" icon={Check} loading={busy === 'approve'} disabled={quality.some((q) => q.level === 'error') && !dirty} onClick={approve} title="Ctrl+Enter">
              {dirty ? 'Save & approve' : 'Approve'}
            </Button>
          )}
          {d.status === 'approved' && (
            <Button icon={Undo2} loading={busy === 'unapprove'} onClick={() => act('unapprove', () => post(`/drafts/${draftId}/unapprove`))}>
              Withdraw approval
            </Button>
          )}
          <Button icon={Save} disabled={!dirty} loading={busy === 'save'} onClick={save} title="Ctrl+S">
            Save edits
          </Button>
          {dirty && (
            <Button variant="ghost" icon={RotateCcw} onClick={() => { setSubject(d.subject || ''); setBody(d.body || ''); }}>
              Discard
            </Button>
          )}
          {['skipped', 'rejected'].includes(d.status) ? (
            <Button icon={Undo2} onClick={() => act('restore', () => post(`/drafts/${draftId}/restore`))}>Restore</Button>
          ) : (
            <>
              <Button icon={SkipForward} loading={busy === 'skip'} onClick={() => act('skip', () => post(`/drafts/${draftId}/skip`), { advance: true })}>
                Skip
              </Button>
              <Button variant="ghost" icon={X} loading={busy === 'reject'} onClick={() => act('reject', () => post(`/drafts/${draftId}/reject`), { advance: true })}>
                Reject
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            icon={Mail}
            loading={busy === 'test'}
            title="Sends this exact content to your own Gmail address"
            onClick={() => act('test', async () => { const r = await post(`/drafts/${draftId}/test-send`); toast(`Test email sent to ${r.sentTo}`); })}
          >
            Send test to me
          </Button>
        </div>
      )}

      {!locked && d.status !== 'queued' && (
        <div className="flex gap-2">
          <Input placeholder="Optional instruction for regeneration, e.g. 'shorter, mention Android experience'" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <Button icon={Sparkles} loading={busy === 'generate'} onClick={() => act('generate', () => post(`/drafts/${draftId}/generate`, { instruction }))}>
            Regenerate
          </Button>
        </div>
      )}

      {data.sendBlockers.length > 0 && (
        <Alert kind="warning" title="Cannot be sent yet">
          <ul className="list-disc pl-4">{data.sendBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Quality checks">
          {quality.length === 0 ? (
            <p className="text-sm text-emerald-700">No issues found.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {quality.map((q) => (
                <li key={q.message} className={q.level === 'error' ? 'text-rose-700' : 'text-amber-700'}>
                  {q.level === 'error' ? '✕' : '!'} {q.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Why it's written this way">
          <p className="text-sm text-slate-700">{d.rationale || '—'}</p>
          {p.points?.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-xs text-slate-600">{p.points.map((x) => <li key={x}>{x}</li>)}</ul>
          )}
          {p.profileFacts?.length > 0 && (
            <p className="mt-2 text-xs text-slate-500"><span className="font-medium">Resume facts used:</span> {p.profileFacts.join('; ')}</p>
          )}
        </Card>
        <Card title="Company facts">
          {company?.summary || company?.facts?.length ? (
            <div className="space-y-2 text-sm">
              {company.summary && <p>{company.summary}</p>}
              <ul className="list-disc pl-4 text-xs text-slate-600">{company.facts.map((f) => <li key={f}>{f}</li>)}</ul>
              <p className="text-xs text-slate-500">
                {company.website && <a className="mr-2 text-indigo-600" href={company.website} target="_blank" rel="noreferrer">website</a>}
                {company.careersUrl && <a className="mr-2 text-indigo-600" href={company.careersUrl} target="_blank" rel="noreferrer">careers</a>}
                Sources: {company.sources.map((s, i) => <a key={s.uri} className="mr-1 text-indigo-600" href={s.uri} target="_blank" rel="noreferrer">[{i + 1}] {s.title}</a>)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{company?.error || (campaign?.company_research ? 'Not researched yet.' : 'Company research is off for this campaign.')}</p>
          )}
        </Card>
        <Card title="History">
          {parent && (
            <details className="mb-2 text-sm">
              <summary className="cursor-pointer text-slate-600">Original email (sent {fmtDate(parent.sent_at)})</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{parent.subject}{'\n\n'}{parent.body}</pre>
            </details>
          )}
          <ul className="space-y-1 text-xs text-slate-600">
            {data.revisions.map((r) => <li key={r.id}>v{r.version} · {r.source.replace('_', ' ')} · {fmtDate(r.created_at)}{r.note ? ` · "${r.note}"` : ''}</li>)}
            {data.approvals.map((a) => (
              <li key={`a${a.id}`}>
                Approval of v{a.version} · {fmtDate(a.approved_at)} {a.revoked_at ? `· revoked (${a.revoked_reason})` : '· active'}
              </li>
            ))}
            {data.attempts.map((a) => (
              <li key={`s${a.id}`}>
                {a.is_test ? 'Test send' : 'Send'} to {a.to_email} · {a.status} · {fmtDate(a.started_at)} {a.error ? `· ${a.error}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

export default function Review() {
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('campaignId') || '';
  const status = params.get('status') ?? 'draft';
  const selectedId = Number(params.get('draft')) || null;
  const [q, setQ] = useState('');
  const { data: campaigns } = useLoad(() => get('/campaigns'));
  const { data: drafts, reload } = useLoad(() => get(`/drafts${qs({ campaignId, status, q })}`), [campaignId, status, q]);

  const setParam = (k, v) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };

  const list = useMemo(() => drafts || [], [drafts]);
  useEffect(() => {
    if (!selectedId && list.length) setParam('draft', String(list[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, selectedId]);

  const next = useCallback(() => {
    const idx = list.findIndex((d) => d.id === selectedId);
    const following = list.slice(idx + 1).find((d) => d.status === 'draft') || list.find((d) => d.id !== selectedId && d.status === 'draft');
    if (following) setParam('draft', String(following.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, selectedId]);

  return (
    <div className="grid h-[calc(100vh-3rem)] gap-5 lg:grid-cols-[340px_1fr]">
      <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="space-y-2 border-b border-slate-100 p-3">
          <h1 className="flex items-center gap-2 font-semibold"><ClipboardCheck className="h-4 w-4" /> Review queue</h1>
          <Select value={campaignId} onChange={(e) => setParam('campaignId', e.target.value)} options={[{ value: '', label: 'All campaigns' }, ...(campaigns || []).map((c) => ({ value: c.id, label: c.name }))]} className="w-full" />
          <div className="flex gap-2">
            <Select
              value={status}
              onChange={(e) => setParam('status', e.target.value || '')}
              options={[
                { value: 'draft', label: 'Needs review' }, { value: 'approved', label: 'Approved' }, { value: 'queued', label: 'Not generated' },
                { value: 'failed,unknown', label: 'Failed' }, { value: 'skipped,rejected', label: 'Skipped / rejected' }, { value: 'sent', label: 'Sent' }, { value: '', label: 'All' },
              ]}
            />
            <Input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <p className="text-xs text-slate-500">{list.length} emails · Ctrl+Enter approves and moves on</p>
        </div>
        <ul className="scroll-thin min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
          {!drafts ? (
            <Spinner />
          ) : list.length === 0 ? (
            <Empty title="Nothing here">Generated drafts waiting for review appear here.</Empty>
          ) : (
            list.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => setParam('draft', String(d.id))} className={cx('w-full px-3 py-2.5 text-left', d.id === selectedId ? 'bg-indigo-50' : 'hover:bg-slate-50')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{d.recruiter_name || d.to_email}</span>
                    <StatusBadge status={d.status} />
                  </div>
                  <p className="truncate text-xs text-slate-500">{d.recruiter_company} · {d.subject || 'not generated'}</p>
                  <div className="mt-0.5 flex gap-1">
                    {d.kind === 'follow_up' && <Badge color="purple">follow-up</Badge>}
                    {d.errors > 0 && <Badge color="red">{d.errors} error</Badge>}
                    {d.warnings > 0 && <Badge color="yellow">{d.warnings} warning</Badge>}
                    {d.relevance_score != null && <Badge>score {d.relevance_score}</Badge>}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
      <div className="scroll-thin min-h-0 overflow-y-auto pr-1">
        {selectedId ? <DraftEditor key={selectedId} draftId={selectedId} onChanged={reload} onNext={next} /> : <Empty title="Select an email to review" />}
      </div>
    </div>
  );
}
