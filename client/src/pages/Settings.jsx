import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Link2, Unlink, XCircle } from 'lucide-react';
import { get, post, put, useLoad } from '../api.js';
import { Alert, Button, Card, ErrorAlert, Input, PageHeader, Spinner, Textarea, useToast } from '../components/ui.jsx';

function StatusLine({ ok, children }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-rose-500" />}
      {children}
    </p>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data, reload, setData } = useLoad(() => get('/settings'));
  const [form, setForm] = useState(null);
  const [models, setModels] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (data) setForm({ gemini_model: data.gemini_model, sender_name: data.sender_name, signature: data.signature, send_delay_seconds: data.send_delay_seconds, daily_send_limit: data.daily_send_limit, research_ttl_days: data.research_ttl_days });
  }, [data]);

  useEffect(() => {
    const g = params.get('gmail');
    if (!g) return;
    if (g === 'connected') toast(`Gmail connected: ${params.get('email')}`);
    else toast(`Gmail connection failed: ${params.get('message')}`, 'error');
    setParams({}, { replace: true });
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(name, fn) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!data || !form) return <Spinner />;
  const s = data.status;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Settings" subtitle="Secrets live in the .env file on this machine and never reach the browser." />
      <ErrorAlert error={error} />

      <Card title="Gemini">
        <div className="space-y-3">
          <StatusLine ok={s.geminiConfigured}>{s.geminiConfigured ? 'GEMINI_API_KEY is set' : 'GEMINI_API_KEY is missing from .env'}</StatusLine>
          {!s.geminiConfigured && (
            <Alert kind="info">
              Create a key at <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>, add{' '}
              <code>GEMINI_API_KEY=…</code> to <code>.env</code> in the project folder, then restart <code>npm run dev</code>.
            </Alert>
          )}
          <div className="flex items-end gap-2">
            <Input label="Model override" value={form.gemini_model ?? ''} onChange={set('gemini_model')} list="gemini-models" placeholder={s.defaultModel} hint={`Leave blank to use ${s.defaultModel} from .env. In use: ${s.activeModel}`} />
            <datalist id="gemini-models">{(models || []).map((m) => <option key={m} value={m} />)}</datalist>
            <Button disabled={!s.geminiConfigured} loading={busy === 'models'} onClick={() => act('models', async () => setModels((await get('/gemini/models')).models))}>
              Load models
            </Button>
            <Button disabled={!s.geminiConfigured} loading={busy === 'test'} onClick={() => act('test', async () => { const r = await post('/gemini/test'); toast(`Gemini OK (${r.model})`); })}>
              Test
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Gmail">
        <div className="space-y-3">
          <StatusLine ok={s.gmailConfigured}>{s.gmailConfigured ? 'OAuth client configured' : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from .env'}</StatusLine>
          <StatusLine ok={!!s.gmailAccount}>{s.gmailAccount ? `Connected as ${s.gmailAccount.email}` : 'Not connected'}</StatusLine>
          {!s.gmailConfigured && (
            <Alert kind="info" title="One-time Google Cloud setup">
              <ol className="list-decimal space-y-0.5 pl-4">
                <li>In Google Cloud Console, create a project and enable the Gmail API.</li>
                <li>Configure the OAuth consent screen (External, Testing) and add your Gmail address as a test user.</li>
                <li>Create an OAuth client ID of type "Web application" with redirect URI <code>{s.gmailRedirectUri}</code>.</li>
                <li>Put the client ID and secret into <code>.env</code> and restart.</li>
              </ol>
            </Alert>
          )}
          <div className="flex gap-2">
            {s.gmailAccount ? (
              <Button icon={Unlink} loading={busy === 'disconnect'} onClick={() => act('disconnect', async () => { await post('/gmail/disconnect'); reload(); })}>
                Disconnect
              </Button>
            ) : (
              <Button variant="primary" icon={Link2} disabled={!s.gmailConfigured} loading={busy === 'connect'} onClick={() => act('connect', async () => { window.location.href = (await get('/gmail/auth-url')).url; })}>
                Connect Gmail
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-500">Scopes requested: send email, and read-only access to detect replies and bounces in the threads you started.</p>
        </div>
      </Card>

      <Card title="Sender & pacing">
        <div className="space-y-3">
          <Input label="Sender display name" value={form.sender_name} onChange={set('sender_name')} placeholder="Your full name" />
          <Textarea
            label="Signature (optional)"
            hint="If set, Gemini ends every email with exactly this block. Otherwise it signs with your name, phone and LinkedIn from the resume."
            rows={4}
            value={form.signature}
            onChange={set('signature')}
          />
          <div className="grid grid-cols-3 gap-3">
            <Input label="Seconds between emails" type="number" min={5} value={form.send_delay_seconds} onChange={set('send_delay_seconds')} />
            <Input label="Daily send limit" type="number" min={1} value={form.daily_send_limit} onChange={set('daily_send_limit')} hint="Rolling 24 hours" />
            <Input label="Re-research companies after (days)" type="number" min={1} value={form.research_ttl_days} onChange={set('research_ttl_days')} />
          </div>
          <div className="flex justify-end">
            <Button variant="primary" loading={busy === 'save'} onClick={() => act('save', async () => { setData(await put('/settings', form)); toast('Settings saved'); })}>
              Save settings
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
