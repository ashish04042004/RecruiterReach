import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Reply, Sparkles } from 'lucide-react';
import { get, post, useLoad, waitForJob } from '../api.js';
import { Badge, Button, Card, Empty, PageHeader, Progress, Spinner, fmtDate, useToast } from '../components/ui.jsx';

const TYPE_COLOR = { reply: 'green', bounce: 'red', opt_out: 'red', note: 'gray' };

export default function FollowUps() {
  const toast = useToast();
  const [selected, setSelected] = useState(new Set());
  const [job, setJob] = useState(null);
  const { data: due, reload: reloadDue } = useLoad(() => get('/followups/due'));
  const { data: interactions, reload: reloadInteractions } = useLoad(() => get('/interactions'));
  const { data: settings, reload: reloadSettings } = useLoad(() => get('/settings'));

  async function sync() {
    try {
      const j = await post('/tracking/sync');
      setJob({ ...j, label: 'Checking Gmail threads for replies and bounces' });
      const done = await waitForJob(j.id, (x) => setJob({ ...x, label: 'Checking Gmail threads for replies and bounces' }));
      setJob(null);
      if (done.status === 'completed') {
        const r = done.result;
        toast(`Checked ${r.threadsChecked} threads: ${r.replies} new replies, ${r.bounces} bounces, ${r.optOuts} opt-outs`);
      } else toast(done.errors[0], 'error');
      reloadDue();
      reloadInteractions();
      reloadSettings();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function createFollowUps() {
    try {
      const r = await post('/followups/create', { draftIds: [...selected] });
      setSelected(new Set());
      reloadDue();
      if (r.job) {
        setJob({ ...r.job, label: 'Drafting follow-ups' });
        const done = await waitForJob(r.job.id, (x) => setJob({ ...x, label: 'Drafting follow-ups' }));
        setJob(null);
        toast(done.failed ? `${done.failed} follow-ups failed to generate: ${done.errors[0]}` : `${r.created.length} follow-ups drafted. Review and approve them before they can be sent.`, done.failed ? 'error' : 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Replies & follow-ups"
        subtitle={`Follow-ups stop automatically once a reply, bounce or opt-out is recorded. Last Gmail check: ${fmtDate(settings?.status.lastSyncAt)}`}
        actions={<Button icon={RefreshCw} loading={!!job && job.type === 'sync_inbox'} onClick={sync} disabled={!settings?.status.gmailAccount}>Check Gmail for replies</Button>}
      />
      {job && <Card><Progress value={job.done} total={job.total} label={job.label} /></Card>}

      <Card
        title={`Follow-ups due (${due?.length ?? 0})`}
        actions={<Button size="sm" variant="primary" icon={Sparkles} disabled={!selected.size || !!job} onClick={createFollowUps}>Draft {selected.size || ''} follow-up{selected.size === 1 ? '' : 's'}</Button>}
        padded={false}
      >
        {!due ? (
          <Spinner />
        ) : !due.length ? (
          <Empty icon={Reply} title="No follow-ups due">Sent emails without a reply appear here after the campaign's follow-up interval.</Empty>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {due.map((d) => (
                <tr key={d.id}>
                  <td className="w-8 px-3 py-2">
                    <input type="checkbox" checked={selected.has(d.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })} />
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{d.recruiter_name || d.to_email}</span> <span className="text-slate-500">{d.recruiter_company}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{d.subject}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">sent {d.days_since} days ago · {d.campaign_name}</td>
                  <td className="px-3 py-2"><Badge>follow-up {d.followup_number + 1} of {d.max_followups}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Recent interactions" padded={false}>
        {!interactions ? (
          <Spinner />
        ) : !interactions.length ? (
          <Empty title="No replies recorded yet" />
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {interactions.map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2"><Badge color={TYPE_COLOR[i.type]}>{i.type.replace('_', ' ')}</Badge></td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{i.recruiter_name || i.recruiter_email}</span> <span className="text-slate-500">{i.recruiter_company}</span>
                  </td>
                  <td className="max-w-lg truncate px-3 py-2 text-xs text-slate-600" title={i.details}>{i.details}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{fmtDate(i.occurred_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-slate-500">
        Mark replies or opt-outs manually from a contact's detail panel on the <Link className="text-indigo-600" to="/contacts">Contacts</Link> page.
      </p>
    </div>
  );
}
