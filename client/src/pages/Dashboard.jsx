import { Link } from 'react-router-dom';
import { CheckCircle2, Circle } from 'lucide-react';
import { get, useLoad } from '../api.js';
import { Card, PageHeader, Spinner, Stat, fmtDate } from '../components/ui.jsx';

function Step({ done, title, children, to, action }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      {done ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" /> : <Circle className="mt-0.5 h-5 w-5 text-slate-300" />}
      <div className="flex-1">
        <p className={done ? 'text-sm text-slate-500' : 'text-sm font-medium text-slate-800'}>{title}</p>
        {!done && children && <p className="text-xs text-slate-500">{children}</p>}
      </div>
      {!done && to && (
        <Link to={to} className="text-sm font-medium text-indigo-600 hover:underline">
          {action}
        </Link>
      )}
    </li>
  );
}

export default function Dashboard() {
  const { data, loading } = useLoad(async () => {
    const [settings, analytics, resumes, campaigns, audit] = await Promise.all([
      get('/settings'), get('/analytics'), get('/resumes'), get('/campaigns'), get('/audit?limit=12'),
    ]);
    return { settings, analytics, resumes, campaigns, audit };
  });
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const { settings, analytics, resumes, campaigns, audit } = data;
  const t = analytics.totals;
  const s = settings.status;

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle="Your outreach at a glance" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Contacts" value={t.contacts} hint={`${t.sendable} sendable · ${t.companies} companies`} />
        <Stat label="Needs review" value={t.pendingReview} hint={`${t.readyToSend} approved, ready to send`} accent="text-amber-600" />
        <Stat label="Sent" value={t.sent} hint={`${t.contacted} people contacted`} accent="text-indigo-600" />
        <Stat label="Reply rate" value={`${t.replyRate}%`} hint={`${t.replied} replied · ${t.bounced} bounced · ${t.followUpsDue} follow-ups due`} accent="text-emerald-600" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Getting started">
          <ol className="divide-y divide-slate-100">
            <Step done={s.geminiConfigured} title="Add your Gemini API key" to="/settings" action="How">
              Put GEMINI_API_KEY in the .env file at the project root and restart the server.
            </Step>
            <Step done={t.contacts > 0} title="Import your recruiter workbook" to="/imports" action="Import">
              Upload the Excel file and review how each sheet's columns are mapped.
            </Step>
            <Step done={resumes.some((r) => r.profile)} title="Upload and analyze your resume" to="/resumes" action="Upload">
              The parsed profile is the only source of facts used in your emails.
            </Step>
            <Step done={campaigns.length > 0} title="Create a campaign and pick recipients" to="/campaigns" action="Create">
              Choose a resume, target roles and companies, then select ranked contacts.
            </Step>
            <Step done={!!s.gmailAccount} title="Connect Gmail" to="/settings" action="Connect">
              OAuth connection to send approved emails from your own account.
            </Step>
            <Step done={t.sent > 0} title="Review, approve and send your first emails" to="/review" action="Review" />
          </ol>
        </Card>

        <Card title="Recent activity" actions={<Link to="/activity" className="text-xs text-indigo-600 hover:underline">View all</Link>}>
          {audit.length === 0 ? (
            <p className="text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {audit.map((a) => (
                <li key={a.id} className="flex justify-between gap-3">
                  <span className="text-slate-700">
                    <span className="font-medium">{a.entity_type}</span>
                    {a.entity_id ? ` #${a.entity_id}` : ''} {a.action.replaceAll('_', ' ')}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{fmtDate(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
