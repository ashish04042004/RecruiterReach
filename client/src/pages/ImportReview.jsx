import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Eye, Sparkles, Upload } from 'lucide-react';
import { get, post, useLoad } from '../api.js';
import {
  Alert, Badge, Button, Card, Checkbox, ErrorAlert, Input, PageHeader, Select, Spinner, Stat, StatusBadge, cx, useToast,
} from '../components/ui.jsx';

function confidenceBadge(col) {
  const { field, confidence } = col.detected;
  if (field === null) return <Badge color="red">unmapped</Badge>;
  if (confidence >= 0.85) return <Badge color="green">high</Badge>;
  if (confidence >= 0.6) return <Badge color="yellow">medium</Badge>;
  return <Badge color="red">low</Badge>;
}

export default function ImportReview() {
  const { id } = useParams();
  const toast = useToast();
  const { data: imp, setData: setImp, loading, error } = useLoad(() => get(`/imports/${id}`), [id]);
  const [mapping, setMapping] = useState(null);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [stale, setStale] = useState(true);
  const [ai, setAi] = useState({});
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!imp) return;
    setMapping(imp.mapping);
    setSelected((s) => s || imp.analysis.sheets.find((x) => !imp.mapping.sheets[x.name]?.skip)?.name || imp.analysis.sheets[0]?.name);
  }, [imp]);

  const committed = imp?.status === 'committed';
  const sheet = imp?.analysis.sheets.find((s) => s.name === selected);
  const sm = mapping?.sheets[selected];

  const groups = useMemo(() => {
    if (!sheet || !sm) return [];
    const base = (!stale && preview?.groups?.[sheet.name]) || sheet.groups || [];
    return base.map((g) => ({ ...g, include: sm.groupInclude?.[g.id] ?? g.include }));
  }, [sheet, sm, preview, stale]);
  const groupOfColumn = useMemo(() => {
    const m = {};
    for (const g of groups) for (const c of g.columns) m[c] = g;
    return m;
  }, [groups]);

  function updateSheet(name, patch) {
    setMapping((m) => ({ ...m, sheets: { ...m.sheets, [name]: { ...m.sheets[name], ...patch } } }));
    setStale(true);
  }

  async function run(label, fn) {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  const doPreview = () =>
    run('preview', async () => {
      setPreview(await post(`/imports/${id}/preview`, { mapping }));
      setStale(false);
    });

  const doCommit = () =>
    run('commit', async () => {
      const r = await post(`/imports/${id}/commit`, { mapping });
      setResult(r);
      setImp({ ...imp, status: 'committed' });
      toast(`Imported ${r.summary.created} new contacts`);
    });

  const doAi = () =>
    run('ai', async () => {
      const { suggestions } = await post(`/imports/${id}/ai-suggest`);
      const map = {};
      for (const s of suggestions) map[`${s.sheet}:${s.column_index}`] = s;
      setAi(map);
      setMapping((m) => {
        const next = structuredClone(m);
        for (const s of suggestions) if (next.sheets[s.sheet]) next.sheets[s.sheet].columns[s.column_index] = s.field;
        return next;
      });
      setStale(true);
      toast(suggestions.length ? `Gemini suggested mappings for ${suggestions.length} columns (marked AI)` : 'No ambiguous columns to resolve');
    });

  const changeHeaderRow = (value) =>
    run('header', async () => {
      const updated = await post(`/imports/${id}/sheets/header-row`, { sheet: selected, headerRowIndex: Number(value) });
      setImp(updated);
      setMapping((m) => ({ ...m, sheets: { ...m.sheets, [selected]: updated.mapping.sheets[selected] } }));
      setStale(true);
    });

  if (loading && !imp) return <Spinner />;
  if (error) return <ErrorAlert error={error} />;
  if (!imp || !mapping) return null;

  const fieldOptions = [{ value: '', label: '— Unmapped (keep as extra info) —' }, ...imp.fields.map((f) => ({ value: f.key, label: f.label }))];
  const included = imp.analysis.sheets.filter((s) => !mapping.sheets[s.name]?.skip);

  return (
    <div className="space-y-5">
      <PageHeader
        title={imp.filename}
        subtitle={`${imp.analysis.sheets.length} sheets · ${included.length} included`}
        actions={
          committed ? (
            <StatusBadge status="committed" />
          ) : (
            <>
              <Button icon={Sparkles} loading={busy === 'ai'} onClick={doAi}>
                Resolve ambiguous columns with Gemini
              </Button>
              <Button icon={Eye} loading={busy === 'preview'} onClick={doPreview}>
                Preview import
              </Button>
              <Button variant="primary" icon={Upload} loading={busy === 'commit'} disabled={stale || !preview} onClick={doCommit} title={stale ? 'Preview first' : ''}>
                Import {preview && !stale ? `${preview.summary.created} contacts` : ''}
              </Button>
            </>
          )
        }
      />
      <ErrorAlert error={actionError} />
      {imp.previousImportOfSameFile && !committed && (
        <Alert kind="warning" title="This exact file was imported before">
          Importing again will merge into existing contacts (no duplicates) and add another source reference.
        </Alert>
      )}
      {result && (
        <Alert kind="success" title="Import complete">
          {result.summary.created} new contacts, {result.summary.mergedWithinImport} duplicates merged across sheets, {result.summary.conflicts} conflicting values kept for review.{' '}
          <Link to="/contacts" className="font-medium underline">
            Open contacts
          </Link>
        </Alert>
      )}

      <Card title="Exclusions">
        <Input
          label="Never import addresses from these domains (comma separated)"
          hint="Auto-detected from student roll-number addresses. Roll-number style addresses (e.g. 23JE0123@…) are always excluded."
          value={(mapping.excludedDomains || []).join(', ')}
          disabled={committed}
          onChange={(e) => {
            setMapping({ ...mapping, excludedDomains: e.target.value.split(',').map((d) => d.trim()).filter(Boolean) });
            setStale(true);
          }}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <Card title="Sheets" padded={false}>
          <ul className="scroll-thin max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
            {imp.analysis.sheets.map((s) => {
              const m = mapping.sheets[s.name];
              const stats = !stale && preview?.summary.sheets[s.name];
              return (
                <li key={s.name}>
                  <button
                    type="button"
                    onClick={() => setSelected(s.name)}
                    className={cx('w-full px-3 py-2 text-left', selected === s.name ? 'bg-indigo-50' : 'hover:bg-slate-50')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cx('truncate text-sm', m?.skip ? 'text-slate-400 line-through' : 'font-medium text-slate-800')}>{s.name}</span>
                      {stats && !m.skip && <Badge color="indigo">{stats.records}</Badge>}
                    </div>
                    <p className="truncate text-xs text-slate-500">
                      {m?.skip ? s.skipReason || 'Skipped' : `${s.dataRowCount} rows`}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {sheet && sm && (
          <div className="min-w-0 space-y-4">
            <Card
              title={`Sheet: ${sheet.name}`}
              actions={<Checkbox label="Include this sheet" checked={!sm.skip} disabled={committed} onChange={(v) => updateSheet(sheet.name, { skip: !v })} />}
            >
              <div className="grid gap-4 md:grid-cols-3">
                <Select
                  label="Header row"
                  value={sm.headerRowIndex}
                  disabled={committed || busy === 'header'}
                  onChange={(e) => changeHeaderRow(e.target.value)}
                  options={[
                    { value: -1, label: 'No header row' },
                    ...sheet.headerPreview.map((r, i) => ({ value: i, label: `Row ${i + 1}: ${r.filter(Boolean).slice(0, 4).join(' | ').slice(0, 60)}` })),
                  ]}
                />
                <div className="space-y-2 pt-5">
                  <Checkbox label={`Use sheet name as company when missing`} checked={sm.companyFromSheetName} disabled={committed} onChange={(v) => updateSheet(sheet.name, { companyFromSheetName: v })} />
                  <Checkbox label="Infer company from corporate email domain" checked={sm.inferCompanyFromDomain} disabled={committed} onChange={(v) => updateSheet(sheet.name, { inferCompanyFromDomain: v })} />
                </div>
                <div className="pt-5 text-xs text-slate-500">
                  {sheet.dataRowCount} data rows · {sheet.columns.filter((c) => c.fillRatio > 0).length} non-empty columns
                </div>
              </div>
              {sheet.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-amber-700">
                  {sheet.warnings.map((w) => (
                    <li key={w}>• {w}</li>
                  ))}
                </ul>
              )}
            </Card>

            {groups.length > 0 && (
              <Card title="Contact groups in each row">
                <p className="mb-3 text-xs text-slate-500">
                  Each included group becomes a separate contact per row. Student and coordinator groups are excluded by default.
                </p>
                <div className="flex flex-wrap gap-3">
                  {groups.map((g) => (
                    <div key={g.id} className={cx('rounded-md border px-3 py-2', g.include ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-slate-50')}>
                      <Checkbox
                        label={<span className="font-medium">{g.label}</span>}
                        checked={g.include}
                        disabled={committed}
                        onChange={(v) => updateSheet(sheet.name, { groupInclude: { ...sm.groupInclude, [g.id]: v } })}
                      />
                      <p className="mt-0.5 text-xs text-slate-500">
                        {g.columns.map((c) => sheet.columns[c]?.header).join(', ')}
                      </p>
                      {g.reason && <p className="text-xs text-amber-700">{g.reason}</p>}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card title="Column mapping" padded={false}>
              <div className="scroll-thin overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Column</th>
                      <th className="px-3 py-2">Sample values</th>
                      <th className="px-3 py-2">Filled</th>
                      <th className="px-3 py-2">Maps to</th>
                      <th className="px-3 py-2">Detection</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sheet.columns
                      .filter((c) => c.fillRatio > 0 || sm.columns[c.index])
                      .map((c) => {
                        const suggestion = ai[`${sheet.name}:${c.index}`];
                        const value = sm.columns[c.index] ?? '';
                        const changed = (value || null) !== (c.detected.confidence >= 0.45 ? c.detected.field : null);
                        const g = groupOfColumn[c.index];
                        return (
                          <tr key={c.index} className={cx(c.ambiguous && !changed && 'bg-amber-50/50')}>
                            <td className="px-3 py-2 align-top">
                              <p className="font-medium text-slate-800">{c.header}</p>
                              {g && <Badge color={g.include ? 'indigo' : 'gray'}>{g.label}</Badge>}
                            </td>
                            <td className="max-w-xs px-3 py-2 align-top text-xs text-slate-600">
                              {c.samples.slice(0, 3).map((s) => (
                                <div key={s} className="truncate">
                                  {s}
                                </div>
                              ))}
                            </td>
                            <td className="px-3 py-2 align-top text-xs text-slate-500">{Math.round(c.fillRatio * 100)}%</td>
                            <td className="px-3 py-2 align-top">
                              <Select
                                value={value}
                                disabled={committed}
                                onChange={(e) => {
                                  const v = e.target.value || null;
                                  updateSheet(sheet.name, { columns: { ...sm.columns, [c.index]: v } });
                                }}
                                options={fieldOptions}
                                className="w-56"
                              />
                            </td>
                            <td className="px-3 py-2 align-top text-xs">
                              <div className="flex flex-wrap items-center gap-1">
                                {confidenceBadge(c)}
                                {suggestion && <Badge color="purple" title={suggestion.reason}>AI</Badge>}
                                {changed && !suggestion && <Badge color="blue">edited</Badge>}
                              </div>
                              <p className="mt-1 max-w-xs text-slate-500">{suggestion?.reason || c.detected.reasons.join('; ')}</p>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </div>

      {preview && (
        <Card title={stale ? 'Preview (out of date: mapping changed, preview again)' : 'Preview'}>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Unique contacts" value={preview.summary.created} />
            <Stat label="Duplicates merged" value={preview.summary.mergedWithinImport + preview.summary.mergedWithExisting} hint={`${preview.summary.mergedWithExisting} with existing contacts`} />
            <Stat label="Conflicting values" value={preview.summary.conflicts} hint="kept for review, not overwritten" />
            <Stat label="Invalid emails" value={preview.summary.invalidEmails} />
            <Stat label="No email" value={preview.summary.missingEmails} />
          </div>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Source</th>
                  <th className="px-2 py-1.5">Action</th>
                  <th className="px-2 py-1.5">Name</th>
                  <th className="px-2 py-1.5">Designation</th>
                  <th className="px-2 py-1.5">Email</th>
                  <th className="px-2 py-1.5">Company</th>
                  <th className="px-2 py-1.5">Phone</th>
                  <th className="px-2 py-1.5">Role hired for</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.samples.map((s, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">
                      {s.sheet.trim()} r{s.row} {s.group}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge color={s.action === 'create' ? 'green' : 'blue'}>{s.action}</Badge>
                    </td>
                    <td className="px-2 py-1.5">{s.name || '—'}</td>
                    <td className="px-2 py-1.5 text-slate-500">{s.designation || ''}</td>
                    <td className="px-2 py-1.5">
                      {s.email || '—'} {s.emailStatus !== 'unchecked' && <StatusBadge status={s.emailStatus} />}
                    </td>
                    <td className="px-2 py-1.5">
                      {s.company || '—'} {s.companySource && s.companySource !== 'column' && <Badge>from {s.companySource}</Badge>}
                    </td>
                    <td className="px-2 py-1.5">{s.phone || ''}</td>
                    <td className="px-2 py-1.5 text-slate-500">{s.jobRole || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!committed && !stale && (
            <div className="mt-4 flex justify-end">
              <Button variant="primary" icon={CheckCircle2} loading={busy === 'commit'} onClick={doCommit}>
                Import {preview.summary.created} contacts
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
