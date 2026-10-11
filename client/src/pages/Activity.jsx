import { useState } from 'react';
import { Download } from 'lucide-react';
import { get, qs, useLoad } from '../api.js';
import { Button, Card, PageHeader, Select, Spinner, fmtDate } from '../components/ui.jsx';

export default function Activity() {
  const [entityType, setEntityType] = useState('');
  const { data } = useLoad(() => get(`/audit${qs({ entityType, limit: 500 })}`), [entityType]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit trail"
        subtitle="Every import, edit, approval, send attempt and detected reply is recorded."
        actions={
          <>
            <a href="/api/export/emails.csv"><Button icon={Download}>Emails & approvals CSV</Button></a>
            <a href="/api/export/audit.csv"><Button icon={Download}>Audit log CSV</Button></a>
            <a href="/api/export/contacts.csv"><Button icon={Download}>Contacts CSV</Button></a>
          </>
        }
      />
      <Card
        padded={false}
        actions={
          <Select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            options={[{ value: '', label: 'All events' }, ...['draft', 'batch', 'campaign', 'recruiter', 'import', 'resume', 'gmail', 'settings', 'system'].map((v) => ({ value: v, label: v }))]}
          />
        }
        title="Events"
      >
        {!data ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {data.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">{fmtDate(a.created_at)}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className="font-medium">{a.entity_type}</span>
                    {a.entity_id ? <span className="text-slate-500"> #{a.entity_id}</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{a.action.replaceAll('_', ' ')}</td>
                  <td className="px-4 py-2">
                    {a.details && <code className="block max-w-2xl truncate text-xs text-slate-500" title={JSON.stringify(a.details)}>{JSON.stringify(a.details)}</code>}
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
