import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Megaphone, Plus } from 'lucide-react';
import { get, post, useLoad } from '../api.js';
import {
  Badge, Button, Card, Checkbox, Empty, ErrorAlert, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Textarea,
} from '../components/ui.jsx';

export const STYLE_OPTIONS = [
  { value: 'concise', label: 'Concise (90–150 words)' },
  { value: 'standard', label: 'Standard (140–200 words)' },
  { value: 'detailed', label: 'Detailed (190–260 words)' },
];

export function CampaignForm({ initial, resumes, onSubmit, submitLabel, busy }) {
  const [v, setV] = useState(() => ({
    name: '', resume_id: resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || '', target_roles: '', target_companies: '',
    target_locations: '', style: 'concise', custom_instructions: '', company_research: true, followup_days: 6, max_followups: 1,
    ...initial,
  }));
  useEffect(() => {
    if (!v.target_roles && !initial?.id) {
      const r = resumes.find((x) => x.id === Number(v.resume_id));
      if (r?.profile?.target_roles?.length) setV((s) => ({ ...s, target_roles: r.profile.target_roles.join(', ') }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.resume_id]);
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...v, resume_id: v.resume_id ? Number(v.resume_id) : null });
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Input label="Campaign name" required value={v.name} onChange={set('name')} placeholder="e.g. SDE roles – product companies" />
        <Select
          label="Resume to attach"
          value={v.resume_id ?? ''}
          onChange={set('resume_id')}
          options={[{ value: '', label: '— choose —' }, ...resumes.map((r) => ({ value: r.id, label: `${r.label}${r.profile ? '' : ' (not analyzed)'}` }))]}
        />
      </div>
      <Input label="Target roles" hint="Comma separated. Used for ranking and to frame the email." value={v.target_roles || ''} onChange={set('target_roles')} />
      <div className="grid gap-3 md:grid-cols-2">
        <Textarea label="Target companies (optional)" hint="Boosts these companies in the ranking" rows={2} value={v.target_companies || ''} onChange={set('target_companies')} />
        <Textarea label="Preferred locations (optional)" rows={2} value={v.target_locations || ''} onChange={set('target_locations')} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Select label="Email style" value={v.style} onChange={set('style')} options={STYLE_OPTIONS} />
        <Input label="Follow up after (days)" type="number" min={1} value={v.followup_days} onChange={set('followup_days')} />
        <Input label="Max follow-ups" type="number" min={0} max={3} value={v.max_followups} onChange={set('max_followups')} />
      </div>
      <Textarea
        label="Extra instructions for Gemini (optional)"
        hint="e.g. Mention I'm open to relocating to Bengaluru. Ask about internal referrals politely."
        rows={2}
        value={v.custom_instructions || ''}
        onChange={set('custom_instructions')}
      />
      <Checkbox
        label="Research each company (official site, products, careers page) with Google Search grounding and use only verified facts"
        checked={v.company_research}
        onChange={(c) => setV({ ...v, company_research: c })}
      />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export default function Campaigns() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { data, loading } = useLoad(async () => {
    const [campaigns, resumes] = await Promise.all([get('/campaigns'), get('/resumes')]);
    return { campaigns, resumes };
  });

  async function create(v) {
    setBusy(true);
    setError(null);
    try {
      const c = await post('/campaigns', v);
      navigate(`/campaigns/${c.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Campaigns"
        subtitle="A campaign pairs one resume and outreach strategy with a hand-picked set of recipients."
        actions={<Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>New campaign</Button>}
      />
      {loading && !data ? (
        <Spinner />
      ) : !data.campaigns.length ? (
        <Card>
          <Empty icon={Megaphone} title="No campaigns yet">
            Create one to choose recipients and generate personalized drafts.
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.campaigns.map((c) => (
            <Link key={c.id} to={`/campaigns/${c.id}`} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-800">{c.name}</h3>
                <StatusBadge status={c.status} />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {c.resume?.label || 'No resume'} · {c.style} · {c.target_roles || 'no target roles'}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge>{c.stats.total} recipients</Badge>
                {c.stats.byStatus.draft > 0 && <Badge color="yellow">{c.stats.byStatus.draft} to review</Badge>}
                {c.stats.byStatus.approved > 0 && <Badge color="green">{c.stats.byStatus.approved} approved</Badge>}
                {c.stats.byStatus.sent > 0 && <Badge color="indigo">{c.stats.byStatus.sent} sent</Badge>}
                {c.stats.replies > 0 && <Badge color="green">{c.stats.replies} replies</Badge>}
              </div>
            </Link>
          ))}
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="New campaign" wide>
        <ErrorAlert error={error} />
        {data && (data.resumes.length ? (
          <CampaignForm resumes={data.resumes} onSubmit={create} submitLabel="Create campaign" busy={busy} />
        ) : (
          <p className="text-sm text-slate-600">
            Upload a resume first on the <Link className="text-indigo-600" to="/resumes">Resumes</Link> page.
          </p>
        ))}
      </Modal>
    </div>
  );
}
