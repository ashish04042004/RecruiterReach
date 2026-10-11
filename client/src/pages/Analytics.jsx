import { get, useLoad } from '../api.js';
import { Card, Empty, PageHeader, Spinner, Stat } from '../components/ui.jsx';

function Table({ rows, columns }) {
  if (!rows.length) return <Empty title="No data yet" />;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase text-slate-500">
        <tr>{columns.map(([, label]) => <th key={label} className="px-3 py-1.5">{label}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r, i) => (
          <tr key={i}>{columns.map(([key, , fmt]) => <td key={key} className="px-3 py-1.5">{fmt ? fmt(r) : r[key] ?? '—'}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

const rate = (r, sent = 'sent') => (r[sent] ? `${Math.round((r.replies / r[sent]) * 100)}%` : '—');

export default function Analytics() {
  const { data } = useLoad(() => get('/analytics'));
  if (!data) return <Spinner />;
  const t = data.totals;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({
      day: d,
      sent: data.daily.find((x) => x.day === d)?.sent || 0,
      replies: data.dailyReplies.find((x) => x.day === d)?.replies || 0,
    });
  }
  const max = Math.max(1, ...days.map((d) => d.sent));

  return (
    <div className="space-y-5">
      <PageHeader title="Analytics" subtitle="What's working: by campaign, style, company and source sheet" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Drafts generated" value={t.generated} />
        <Stat label="Approved" value={t.approved} />
        <Stat label="Sent" value={t.sent} hint={`${t.followUpsSent} follow-ups`} />
        <Stat label="Replied" value={t.replied} accent="text-emerald-600" />
        <Stat label="Reply rate" value={`${t.replyRate}%`} accent="text-emerald-600" />
        <Stat label="Bounced" value={t.bounced} accent="text-rose-600" />
        <Stat label="Opted out" value={t.optedOut} />
      </div>

      <Card title="Last 30 days">
        <div className="flex h-36 items-end gap-1">
          {days.map((d) => (
            <div key={d.day} className="group relative flex flex-1 flex-col items-center justify-end" title={`${d.day}: ${d.sent} sent, ${d.replies} replies`}>
              <div className="w-full rounded-t bg-indigo-400" style={{ height: `${(d.sent / max) * 100}%`, minHeight: d.sent ? 3 : 0 }} />
              {d.replies > 0 && <div className="absolute -top-1 h-2 w-2 rounded-full bg-emerald-500" />}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">Bars: emails sent per day. Green dots: days with replies.</p>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="By campaign" padded={false}>
          <Table rows={data.byCampaign} columns={[['name', 'Campaign'], ['style', 'Style'], ['sent', 'Sent'], ['replies', 'Replies'], ['rate', 'Rate', (r) => rate(r)], ['bounces', 'Bounces']]} />
        </Card>
        <Card title="By email style" padded={false}>
          <Table rows={data.byStyle} columns={[['style', 'Style'], ['sent', 'Sent'], ['replies', 'Replies'], ['rate', 'Rate', (r) => rate(r)]]} />
        </Card>
        <Card title="Companies with the most responses" padded={false}>
          <Table rows={data.byCompany} columns={[['company', 'Company'], ['sent', 'Sent'], ['replies', 'Replies']]} />
        </Card>
        <Card title="By source sheet" padded={false}>
          <Table rows={data.bySheet} columns={[['sheet', 'Sheet'], ['contacted', 'Contacted'], ['replies', 'Replies'], ['rate', 'Rate', (r) => rate(r, 'contacted')]]} />
        </Card>
      </div>
    </div>
  );
}
