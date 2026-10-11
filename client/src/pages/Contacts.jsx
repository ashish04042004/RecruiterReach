import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Download, MailCheck, Users } from 'lucide-react';
import { get, patch, post, qs, useLoad, waitForJob } from '../api.js';
import {
  Badge, Button, Card, Drawer, Empty, ErrorAlert, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, cx, fmtDate, useToast,
} from '../components/ui.jsx';

const FIELDS = [
  ['name', 'Name'], ['email', 'Email'], ['company', 'Company'], ['designation', 'Designation'], ['phone', 'Phone'],
  ['location', 'Location'], ['linkedin', 'LinkedIn'], ['job_roles', 'Roles hired for'], ['notes', 'Notes'],
];

export function ContactDrawer({ id, onClose, onChanged }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => (id ? get(`/recruiters/${id}`) : Promise.resolve(null)), [id]);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    if (data) setForm(Object.fromEntries(FIELDS.map(([k]) => [k, data.recruiter[k] || ''])));
  }, [data]);

  async function save(body) {
    setSaving(true);
    setSaveError(null);
    try {
      await patch(`/recruiters/${id}`, body);
      await reload();
      onChanged?.();
      toast('Contact updated');
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  const r = data?.recruiter;
  return (
    <Drawer open={!!id} onClose={onClose} title={r ? r.name || r.email || `Contact #${r.id}` : 'Contact'}>
      {error && <ErrorAlert error={error} />}
      {!data ? (
        <Spinner />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={r.email_status} />
            <StatusBadge status={r.contact_status} />
            {r.do_not_contact && <Badge color="red">do not contact</Badge>}
            {r.is_free_domain && <Badge color="yellow">personal email domain</Badge>}
          </div>
          <ErrorAlert error={saveError} />

          <div className="grid grid-cols-2 gap-3">
            {FIELDS.map(([k, label]) => (
              <div key={k} className={k === 'notes' || k === 'job_roles' ? 'col-span-2' : ''}>
                <Input label={label} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                {r.conflicts[k] && (
                  <div className="mt-1 rounded border border-amber-200 bg-amber-50 p-2 text-xs">
                    <p className="mb-1 font-medium text-amber-800">Conflicting values from other sheets:</p>
                    {r.conflicts[k].map((c) => (
                      <div key={`${c.value}-${c.source}`} className="flex items-center justify-between gap-2 py-0.5">
                        <span>
                          <span className="font-medium">{c.value}</span> <span className="text-slate-500">({c.source})</span>
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => save({ resolveConflict: { field: k, value: c.value } })}>
                          Use
                        </Button>
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => save({ resolveConflict: { field: k } })}>
                      Keep current & dismiss
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={saving} onClick={() => save(form)}>
              Save changes
            </Button>
            <Button variant={r.do_not_contact ? 'secondary' : 'danger'} icon={Ban} onClick={() => save({ do_not_contact: !r.do_not_contact })}>
              {r.do_not_contact ? 'Allow contact' : 'Do not contact'}
            </Button>
            {r.contact_status !== 'opted_out' && (
              <Button onClick={async () => { await post(`/recruiters/${id}/opt-out`); reload(); onChanged?.(); }}>Mark opted out</Button>
            )}
            {r.contact_status === 'contacted' && (
              <Button onClick={async () => { await post('/interactions', { recruiterId: id, type: 'reply', details: 'Marked replied manually' }); reload(); onChanged?.(); }}>
                Mark replied
              </Button>
            )}
          </div>

          {Object.keys(r.extra).length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Other information</h4>
              <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1 text-sm">
                {Object.entries(r.extra).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="truncate text-slate-500">{k}</dt>
                    <dd className="text-slate-800">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Sources in your workbook</h4>
            <ul className="space-y-1 text-sm">
              {data.sources.map((s) => (
                <li key={s.id} className="rounded bg-slate-50 px-2 py-1">
                  <span className="font-medium">{s.sheet_name.trim()}</span> · row {s.row_number}
                  {s.contact_group && <span className="text-slate-500"> · {s.contact_group}</span>}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Emails</h4>
            {data.drafts.length === 0 ? (
              <p className="text-sm text-slate-500">Not in any campaign yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.drafts.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2">
                    <Link to={`/review?draft=${d.id}`} className="truncate text-indigo-600 hover:underline">
                      {d.kind === 'follow_up' ? `Follow-up ${d.followup_number}: ` : ''}
                      {d.subject || '(not generated)'} <span className="text-slate-400">· {d.campaign_name}</span>
                    </Link>
                    <StatusBadge status={d.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.interactions.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Interactions</h4>
              <ul className="space-y-1 text-sm">
                {data.interactions.map((i) => (
                  <li key={i.id}>
                    <Badge color={i.type === 'reply' ? 'green' : i.type === 'note' ? 'gray' : 'red'}>{i.type}</Badge>{' '}
                    <span className="text-slate-500">{fmtDate(i.occurred_at)}</span>
                    <p className="text-xs text-slate-600">{i.details}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

export default function Contacts() {
  const toast = useToast();
  const [filters, setFilters] = useState({ q: '', sheet: '', emailStatus: '', contactStatus: '', hasConflicts: '', multiSource: '', sort: 'company' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const { data: facets, reload: reloadFacets } = useLoad(() => get('/recruiters/facets'));
  const { data, loading, error, reload } = useLoad(() => get(`/recruiters${qs({ ...filters, page, pageSize: 50 })}`), [JSON.stringify(filters), page]);

  const setFilter = (k, v) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  async function verify() {
    const job = await post('/recruiters/verify-emails');
    setVerifying(job);
    const done = await waitForJob(job.id, setVerifying);
    setVerifying(null);
    toast(done.status === 'completed' ? `Domains checked: ${done.result.valid} valid, ${done.result.no_mx} without mail server` : `Verification failed: ${done.errors[0]}`, done.status === 'completed' ? 'success' : 'error');
    reload();
    reloadFacets();
  }

  async function bulk(action) {
    await post('/recruiters/bulk', { ids: [...selected], action });
    setSelected(new Set());
    reload();
    toast(`${selected.size} contacts updated`);
  }

  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contacts"
        subtitle={facets ? `${facets.total} contacts · ${facets.multiSource} appear in multiple sheets · ${facets.withConflicts} with conflicting values` : ''}
        actions={
          <>
            <Button icon={MailCheck} loading={!!verifying} onClick={verify}>
              {verifying ? `Checking domains ${verifying.done}/${verifying.total}` : 'Verify email domains'}
            </Button>
            <a href="/api/export/contacts.csv">
              <Button icon={Download}>Export CSV</Button>
            </a>
          </>
        }
      />

      <Card padded>
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Search name, email, company, role…" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} className="w-72" />
          <Select value={filters.sheet} onChange={(e) => setFilter('sheet', e.target.value)} options={[{ value: '', label: 'All sheets' }, ...(facets?.sheets || []).map((s) => ({ value: s.value, label: `${s.name} (${s.count})` }))]} />
          <Select
            value={filters.emailStatus}
            onChange={(e) => setFilter('emailStatus', e.target.value)}
            options={[{ value: '', label: 'Any email status' }, ...['valid', 'unchecked', 'invalid', 'missing', 'no_mx', 'bounced'].map((s) => ({ value: s, label: s }))]}
          />
          <Select
            value={filters.contactStatus}
            onChange={(e) => setFilter('contactStatus', e.target.value)}
            options={[{ value: '', label: 'Any outreach status' }, ...['new', 'contacted', 'replied', 'bounced', 'opted_out'].map((s) => ({ value: s, label: s }))]}
          />
          <Select value={filters.hasConflicts} onChange={(e) => setFilter('hasConflicts', e.target.value)} options={[{ value: '', label: 'Conflicts: any' }, { value: 'true', label: 'Has conflicts' }]} />
          <Select value={filters.multiSource} onChange={(e) => setFilter('multiSource', e.target.value)} options={[{ value: '', label: 'Sheets: any' }, { value: 'true', label: 'In multiple sheets' }]} />
          <Select value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)} options={[{ value: 'company', label: 'Sort: company' }, { value: 'name', label: 'Sort: name' }, { value: 'updated', label: 'Sort: recently updated' }, { value: 'contacted', label: 'Sort: last contacted' }]} />
        </div>
        {selected.size > 0 && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span>{selected.size} selected</span>
            <Button size="sm" variant="danger" onClick={() => bulk('dnc')}>
              Mark do-not-contact
            </Button>
            <Button size="sm" onClick={() => bulk('undnc')}>
              Allow contact
            </Button>
          </div>
        )}
      </Card>

      <ErrorAlert error={error} />
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : !data?.items.length ? (
          <Empty icon={Users} title="No contacts match">
            {facets?.total === 0 ? <Link to="/imports" className="text-indigo-600">Import your workbook</Link> : 'Try different filters.'}
          </Empty>
        ) : (
          <>
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="w-8 px-3 py-2" />
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Company</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Sheets</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((r) => (
                    <tr key={r.id} className={cx('cursor-pointer hover:bg-slate-50', r.do_not_contact && 'opacity-60')} onClick={() => setOpenId(r.id)}>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium text-slate-800">{r.name || '—'}</p>
                        <p className="text-xs text-slate-500">{r.designation}</p>
                      </td>
                      <td className="px-3 py-2">
                        <p>{r.company || '—'}</p>
                        {r.job_roles && <p className="max-w-xs truncate text-xs text-slate-500">{r.job_roles}</p>}
                      </td>
                      <td className="px-3 py-2">
                        <p className="text-slate-700">{r.email || '—'}</p>
                        <StatusBadge status={r.email_status} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge status={r.contact_status} />
                          {r.do_not_contact && <Badge color="red">DNC</Badge>}
                          {Object.keys(r.conflicts).length > 0 && <Badge color="yellow">conflicts</Badge>}
                        </div>
                      </td>
                      <td className="max-w-[220px] px-3 py-2 text-xs text-slate-500">
                        <span title={r.sheets}>{r.sheets}</span>
                        {r.source_count > 1 && <Badge className="ml-1">{r.source_count} rows</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <ContactDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => { reload(); reloadFacets(); }} />
    </div>
  );
}
