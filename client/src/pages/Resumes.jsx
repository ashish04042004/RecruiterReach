import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, RefreshCw, Star, Trash2, Upload } from 'lucide-react';
import { del, get, patch, post, upload, useLoad } from '../api.js';
import {
  Alert, Badge, Button, Card, Empty, ErrorAlert, Input, PageHeader, Spinner, Textarea, cx, fmtDate, useToast,
} from '../components/ui.jsx';

const TEXT_FIELDS = [
  ['candidate_name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['linkedin', 'LinkedIn'], ['portfolio', 'GitHub / portfolio'],
  ['location', 'Location'], ['current_role', 'Current role'], ['current_company', 'Current company'], ['total_experience_years', 'Experience (years)'],
];
const LONG_FIELDS = [['headline', 'Headline'], ['summary', 'Summary'], ['value_proposition', 'What you bring (used to frame emails)']];
const LIST_FIELDS = [
  ['target_roles', 'Target roles', 'Used for relevance and email framing'],
  ['preferred_locations', 'Preferred locations', ''],
  ['technical_skills', 'Technical skills', ''],
  ['achievements', 'Achievements', 'One per line'],
  ['certifications', 'Certifications', 'One per line'],
];
const JSON_FIELDS = [['experience', 'Experience'], ['education', 'Education'], ['projects', 'Projects']];

function ProfileEditor({ resume, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState({});
  const [jsonText, setJsonText] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const p = resume.profile || {};
    setDraft(p);
    setJsonText(Object.fromEntries(JSON_FIELDS.map(([k]) => [k, JSON.stringify(p[k] || [], null, 2)])));
  }, [resume]);

  async function save() {
    setError(null);
    const profile = { ...draft };
    try {
      for (const [k, label] of JSON_FIELDS) {
        try {
          profile[k] = JSON.parse(jsonText[k] || '[]');
        } catch {
          throw new Error(`${label} is not valid JSON`);
        }
      }
      for (const [k] of LIST_FIELDS) {
        if (typeof profile[k] === 'string') profile[k] = profile[k].split(/\n|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
      }
      if (profile.total_experience_years !== undefined && profile.total_experience_years !== '') profile.total_experience_years = Number(profile.total_experience_years);
      setSaving(true);
      await patch(`/resumes/${resume.id}`, { profile });
      toast('Profile saved');
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const listValue = (k) => (Array.isArray(draft[k]) ? draft[k].join(k === 'achievements' || k === 'certifications' ? '\n' : ', ') : draft[k] || '');

  return (
    <div className="space-y-4">
      <Alert kind="info">
        This profile is the only source of facts about you that Gemini may use. Correct anything inaccurate before generating emails.
      </Alert>
      <ErrorAlert error={error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {TEXT_FIELDS.map(([k, label]) => (
          <Input key={k} label={label} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
        ))}
      </div>
      {LONG_FIELDS.map(([k, label]) => (
        <Textarea key={k} label={label} rows={2} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
      ))}
      <div className="grid gap-3 md:grid-cols-2">
        {LIST_FIELDS.map(([k, label, hint]) => (
          <Textarea key={k} label={label} hint={hint || 'Comma separated'} rows={3} value={listValue(k)} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {JSON_FIELDS.map(([k, label]) => (
          <Textarea key={k} label={`${label} (JSON)`} rows={12} className="font-mono text-xs" value={jsonText[k] ?? ''} onChange={(e) => setJsonText({ ...jsonText, [k]: e.target.value })} />
        ))}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} onClick={save}>
          Save profile
        </Button>
      </div>
    </div>
  );
}

export default function Resumes() {
  const toast = useToast();
  const fileRef = useRef(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const { data: resumes, loading, reload } = useLoad(() => get('/resumes'));
  const { data: selected, reload: reloadSelected } = useLoad(() => (selectedId ? get(`/resumes/${selectedId}`) : Promise.resolve(null)), [selectedId]);

  useEffect(() => {
    if (!selectedId && resumes?.length) setSelectedId(resumes[0].id);
  }, [resumes, selectedId]);

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

  const onFile = (file) =>
    act('upload', async () => {
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      form.append('label', label);
      const r = await upload('/resumes', form);
      setLabel('');
      if (fileRef.current) fileRef.current.value = '';
      await reload();
      setSelectedId(r.id);
      toast(r.profile ? 'Resume uploaded and analyzed' : 'Resume uploaded');
    });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Resumes"
        subtitle="Keep versions for different job families. Each email records the exact file it was approved with."
        actions={
          <>
            <Input placeholder="Label, e.g. SDE – Android" value={label} onChange={(e) => setLabel(e.target.value)} className="w-56" />
            <input ref={fileRef} type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <Button variant="primary" icon={Upload} loading={busy === 'upload'} onClick={() => fileRef.current?.click()}>
              Upload PDF / DOCX
            </Button>
          </>
        }
      />
      <ErrorAlert error={error} />
      {loading && !resumes ? (
        <Spinner />
      ) : !resumes?.length ? (
        <Card>
          <Empty icon={FileText} title="No resume yet">
            Upload your resume. Gemini extracts your experience, skills, education and projects into an editable profile.
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            {resumes.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={cx('w-full rounded-lg border bg-white p-3 text-left shadow-sm', selectedId === r.id ? 'border-indigo-400 ring-1 ring-indigo-400' : 'border-slate-200 hover:border-slate-300')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{r.label}</span>
                  {r.isDefault && <Badge color="indigo">default</Badge>}
                </div>
                <p className="truncate text-xs text-slate-500">{r.originalFilename}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.profile ? <Badge color="green">analyzed</Badge> : <Badge color="yellow">not analyzed</Badge>}
                  {r.usage.drafts > 0 && <Badge>{r.usage.drafts} emails</Badge>}
                </div>
              </button>
            ))}
          </div>

          {selected && (
            <Card
              title={selected.label}
              actions={
                <>
                  <a href={`/api/resumes/${selected.id}/file`} target="_blank" rel="noreferrer">
                    <Button size="sm" icon={ExternalLink}>Open file</Button>
                  </a>
                  {!selected.isDefault && (
                    <Button size="sm" icon={Star} onClick={() => act('default', async () => { await patch(`/resumes/${selected.id}`, { isDefault: true }); reload(); reloadSelected(); })}>
                      Make default
                    </Button>
                  )}
                  <Button size="sm" icon={RefreshCw} loading={busy === 'analyze'} onClick={() => act('analyze', async () => { await post(`/resumes/${selected.id}/analyze`); await reloadSelected(); reload(); toast('Profile re-extracted'); })}>
                    {selected.profile ? 'Re-analyze' : 'Analyze with Gemini'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash2}
                    disabled={selected.usage.drafts > 0 || selected.usage.campaigns > 0}
                    title={selected.usage.drafts || selected.usage.campaigns ? 'In use; kept for the audit trail' : ''}
                    onClick={() => act('delete', async () => { await del(`/resumes/${selected.id}`); setSelectedId(null); reload(); })}
                  />
                </>
              }
            >
              <p className="mb-3 text-xs text-slate-500">
                Uploaded {fmtDate(selected.createdAt)} · SHA-256 {selected.fileHash.slice(0, 12)}… · {(selected.fileSize / 1024).toFixed(0)} KB
              </p>
              {selected.analysisError && <Alert kind="warning" title="Profile not extracted" className="mb-3">{selected.analysisError}</Alert>}
              {selected.profile ? (
                <ProfileEditor resume={selected} onSaved={() => { reloadSelected(); reload(); }} />
              ) : (
                <details>
                  <summary className="cursor-pointer text-sm text-slate-600">Extracted text ({selected.text?.length || 0} characters)</summary>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">{selected.text || '(no text layer found; Gemini will read the PDF directly)'}</pre>
                </details>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
