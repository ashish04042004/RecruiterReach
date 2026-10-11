import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pause, Play, Search, Send, Square } from 'lucide-react';
import { get, post, useLoad } from '../api.js';
import { Alert, Badge, Button, Card, Empty, PageHeader, Progress, Spinner, StatusBadge, cx, fmtDate, useToast } from '../components/ui.jsx';

function BatchDetail({ id, onChanged }) {
  const toast = useToast();
  const { data: b, reload } = useLoad(() => get(`/send/batches/${id}`), [id]);
  useEffect(() => {
    if (b?.status !== 'running') return undefined;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [b?.status, reload]);
  if (!b) return <Spinner />;
  const done = b.counts.sent + b.counts.failed + b.counts.unknown + b.counts.blocked;

  async function action(a) {
    try {
      await post(`/send/batches/${id}/${a}`);
      reload();
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <Card
      title={`Batch #${b.id} · ${b.campaignName || ''}`}
      actions={
        <>
          <StatusBadge status={b.status} />
          {b.status === 'running' && <Button size="sm" icon={Pause} onClick={() => action('pause')}>Pause</Button>}
          {b.status === 'paused' && <Button size="sm" variant="primary" icon={Play} onClick={() => action('resume')}>Resume</Button>}
          {['running', 'paused'].includes(b.status) && <Button size="sm" variant="ghost" icon={Square} onClick={() => action('cancel')}>Cancel</Button>}
        </>
      }
    >
      <Progress value={done} total={b.total} label={`${b.counts.sent} sent · ${b.counts.failed} failed · ${b.counts.blocked} blocked · ${b.counts.unknown} unknown`} />
      {b.statusReason && <p className="mt-2 text-sm text-amber-700">{b.statusReason}</p>}
      <table className="mt-4 w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {b.items.map((d) => (
            <tr key={d.id}>
              <td className="py-1.5">
                <span className="font-medium">{d.name || d.to_email}</span> <span className="text-slate-500">{d.company}</span>
              </td>
              <td className="py-1.5 text-slate-600">{d.subject}</td>
              <td className="py-1.5">
                <StatusBadge status={d.result?.status || 'pending'} />
              </td>
              <td className="max-w-xs py-1.5 text-xs text-rose-600">{d.result?.error}</td>
              <td className="py-1.5 text-xs text-slate-500">{d.sent_at ? fmtDate(d.sent_at) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function Sending() {
  const { id } = useParams();
  const toast = useToast();
  const { data: batches, reload } = useLoad(() => get('/send/batches'));
  const { data: settings } = useLoad(() => get('/settings'));
  const unknown = batches?.reduce((s, b) => s + b.counts.unknown, 0) || 0;

  async function reconcile() {
    try {
      const r = await post('/send/reconcile');
      toast(`Checked ${r.checked}: ${r.confirmedSent} confirmed sent, ${r.markedFailed} not found (safe to retry)${r.errors.length ? `; ${r.errors[0]}` : ''}`);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sending"
        subtitle={settings ? `${settings.status.gmailAccount ? `From ${settings.status.gmailAccount.email}` : 'Gmail not connected'} · ${settings.daily_send_limit}/day · ~${settings.send_delay_seconds}s between emails` : ''}
        actions={<Button icon={Search} onClick={reconcile}>Reconcile unknown outcomes</Button>}
      />
      {unknown > 0 && (
        <Alert kind="warning" title="Some sends were interrupted">
          Their outcome is unknown, so they will not be retried automatically. Reconcile checks your Gmail Sent folder: found messages are marked sent, missing ones become safe to retry.
        </Alert>
      )}
      {id && <BatchDetail id={id} onChanged={reload} />}
      <Card title="Batches" padded={false}>
        {!batches ? (
          <Spinner />
        ) : !batches.length ? (
          <Empty icon={Send} title="Nothing sent yet">Approve emails, then confirm sending from a campaign's Send tab.</Empty>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {batches.map((b) => (
                <tr key={b.id} className={cx(String(b.id) === id && 'bg-indigo-50')}>
                  <td className="px-4 py-2">
                    <Link to={`/sending/${b.id}`} className="font-medium text-indigo-600">Batch #{b.id}</Link> <span className="text-slate-500">{b.campaignName}</span>
                  </td>
                  <td className="px-4 py-2"><StatusBadge status={b.status} /></td>
                  <td className="px-4 py-2 text-slate-600">
                    {b.counts.sent}/{b.total} sent {b.counts.failed > 0 && <Badge color="red">{b.counts.failed} failed</Badge>} {b.counts.unknown > 0 && <Badge color="purple">{b.counts.unknown} unknown</Badge>}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{fmtDate(b.confirmedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
