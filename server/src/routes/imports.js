import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { IMPORTS_DIR } from '../config.js';
import { q, now, parseJson, audit } from '../db.js';
import {
  FIELDS, FIELD_KEYS, analyzeSheet, analyzeWorkbook, defaultMapping, defaultSheetMapping, extractRecords, readWorkbook,
  resolveGroups,
} from '../lib/excel.js';
import { commitRecords } from '../lib/importer.js';
import { generateJson } from '../lib/gemini.js';
import { httpError, requireId } from '../lib/http.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const ALLOWED = new Set(['.xlsx', '.xlsm', '.xls', '.csv', '.ods']);

const wbCache = new Map();
function workbookFor(imp) {
  if (wbCache.has(imp.id)) return wbCache.get(imp.id);
  if (!fs.existsSync(imp.stored_path)) throw httpError(410, 'The uploaded workbook file is missing. Upload it again.');
  const wb = readWorkbook(fs.readFileSync(imp.stored_path));
  wbCache.clear();
  wbCache.set(imp.id, wb);
  return wb;
}

function loadImport(id) {
  const imp = q.get('SELECT * FROM imports WHERE id = ?', requireId(id));
  if (!imp) throw httpError(404, 'Import not found');
  return imp;
}

function serialize(imp) {
  const analysis = parseJson(imp.analysis_json, { sheets: [] });
  const mapping = parseJson(imp.mapping_json) || defaultMapping(analysis);
  const previous = q.get(
    "SELECT id, committed_at FROM imports WHERE file_hash = ? AND id != ? AND status = 'committed' ORDER BY id DESC LIMIT 1",
    imp.file_hash,
    imp.id,
  );
  return {
    id: imp.id,
    filename: imp.filename,
    status: imp.status,
    createdAt: imp.created_at,
    committedAt: imp.committed_at,
    summary: parseJson(imp.summary_json),
    previousImportOfSameFile: previous || null,
    analysis,
    mapping,
    fields: FIELDS,
  };
}

function validateMapping(analysis, mapping) {
  if (!mapping?.sheets) throw httpError(400, 'Mapping is required');
  for (const sheet of analysis.sheets) {
    const m = mapping.sheets[sheet.name];
    if (!m) continue;
    for (const [idx, field] of Object.entries(m.columns || {})) {
      if (field !== null && !FIELD_KEYS.includes(field)) throw httpError(400, `Unknown field "${field}" for ${sheet.name} column ${idx}`);
    }
  }
  return {
    excludedDomains: (mapping.excludedDomains || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean),
    sheets: mapping.sheets,
  };
}

router.get('/', (req, res) => {
  const rows = q.all('SELECT id, filename, status, created_at, committed_at, summary_json FROM imports ORDER BY id DESC');
  res.json(rows.map((r) => ({ id: r.id, filename: r.filename, status: r.status, createdAt: r.created_at, committedAt: r.committed_at, summary: parseJson(r.summary_json) })));
});

router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) throw httpError(400, 'Choose an Excel workbook to upload');
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!ALLOWED.has(ext)) throw httpError(400, `Unsupported file type ${ext}. Upload .xlsx, .xls, .csv or .ods`);
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const stored = path.join(IMPORTS_DIR, `${hash.slice(0, 16)}${ext}`);
  fs.writeFileSync(stored, req.file.buffer);

  const wb = readWorkbook(req.file.buffer);
  const analysis = analyzeWorkbook(wb);
  const mapping = defaultMapping(analysis);
  const result = q.run(
    'INSERT INTO imports (filename, stored_path, file_hash, status, analysis_json, mapping_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    req.file.originalname, stored, hash, 'analyzed', analysis, mapping, now(),
  );
  const id = Number(result.lastInsertRowid);
  wbCache.clear();
  wbCache.set(id, wb);
  audit('import', id, 'uploaded', { filename: req.file.originalname, sheets: analysis.sheets.length });
  res.status(201).json(serialize(q.get('SELECT * FROM imports WHERE id = ?', id)));
});

router.get('/:id', (req, res) => res.json(serialize(loadImport(req.params.id))));

router.put('/:id/mapping', (req, res) => {
  const imp = loadImport(req.params.id);
  const mapping = validateMapping(parseJson(imp.analysis_json), req.body.mapping);
  q.run('UPDATE imports SET mapping_json = ? WHERE id = ?', mapping, imp.id);
  res.json({ ok: true });
});

router.post('/:id/sheets/header-row', (req, res) => {
  const imp = loadImport(req.params.id);
  if (imp.status === 'committed') throw httpError(409, 'This import has already been committed');
  const { sheet: sheetName, headerRowIndex } = req.body;
  const analysis = parseJson(imp.analysis_json);
  const idx = analysis.sheets.findIndex((s) => s.name === sheetName);
  if (idx < 0) throw httpError(404, 'Sheet not found');
  const sheet = analyzeSheet(workbookFor(imp), sheetName, Number(headerRowIndex));
  analysis.sheets[idx] = sheet;
  const mapping = parseJson(imp.mapping_json) || defaultMapping(analysis);
  mapping.sheets[sheetName] = { ...defaultSheetMapping(sheet), skip: false };
  q.run('UPDATE imports SET analysis_json = ?, mapping_json = ? WHERE id = ?', analysis, mapping, imp.id);
  res.json(serialize(q.get('SELECT * FROM imports WHERE id = ?', imp.id)));
});

function runImport(imp, mapping, dryRun) {
  const analysis = parseJson(imp.analysis_json);
  const { records, sheetStats } = extractRecords(workbookFor(imp), analysis, mapping);
  const { summary, samples } = commitRecords(imp.id, records, { dryRun });
  const groups = Object.fromEntries(
    analysis.sheets.map((s) => [s.name, mapping.sheets[s.name] ? resolveGroups(s, mapping.sheets[s.name]) : []]),
  );
  return { summary: { ...summary, sheets: sheetStats }, samples, groups };
}

router.post('/:id/preview', (req, res) => {
  const imp = loadImport(req.params.id);
  const mapping = validateMapping(parseJson(imp.analysis_json), req.body.mapping);
  q.run('UPDATE imports SET mapping_json = ? WHERE id = ?', mapping, imp.id);
  res.json(runImport(imp, mapping, true));
});

router.post('/:id/commit', (req, res) => {
  const imp = loadImport(req.params.id);
  if (imp.status === 'committed') throw httpError(409, 'This import has already been committed');
  const mapping = validateMapping(parseJson(imp.analysis_json), req.body.mapping);
  const result = runImport(imp, mapping, false);
  q.run(
    "UPDATE imports SET status = 'committed', mapping_json = ?, summary_json = ?, committed_at = ? WHERE id = ?",
    mapping, result.summary, now(), imp.id,
  );
  audit('import', imp.id, 'committed', result.summary);
  res.json(result);
});

router.delete('/:id', (req, res) => {
  const imp = loadImport(req.params.id);
  if (imp.status === 'committed') throw httpError(409, 'Committed imports cannot be deleted; their contacts keep the source link');
  q.run('DELETE FROM imports WHERE id = ?', imp.id);
  const stillUsed = q.get('SELECT id FROM imports WHERE stored_path = ?', imp.stored_path);
  if (!stillUsed) fs.rmSync(imp.stored_path, { force: true });
  wbCache.delete(imp.id);
  res.json({ ok: true });
});

const AI_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sheet: { type: 'string' },
          column_index: { type: 'integer' },
          field: { type: 'string', enum: [...FIELD_KEYS, 'unmapped'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['sheet', 'column_index', 'field', 'reason'],
      },
    },
  },
  required: ['suggestions'],
};

router.post('/:id/ai-suggest', async (req, res) => {
  const imp = loadImport(req.params.id);
  const analysis = parseJson(imp.analysis_json);
  const mapping = parseJson(imp.mapping_json) || defaultMapping(analysis);
  const ambiguous = [];
  for (const sheet of analysis.sheets) {
    if (mapping.sheets[sheet.name]?.skip) continue;
    for (const col of sheet.columns) {
      if (!col.ambiguous) continue;
      ambiguous.push({
        sheet: sheet.name,
        column_index: col.index,
        header: col.header,
        neighbouring_headers: sheet.columns.filter((c) => Math.abs(c.index - col.index) <= 2 && c.index !== col.index).map((c) => c.header),
        sample_values: col.samples.slice(0, 4).map((v) => v.slice(0, 60)),
      });
    }
  }
  if (!ambiguous.length) return res.json({ suggestions: [] });

  const fieldGuide = FIELDS.map((f) => `${f.key}: ${f.label}`).join('\n');
  const result = await generateJson({
    system: `You map spreadsheet columns from a recruiter-contact workbook to canonical fields.
Fields:
${fieldGuide}
unmapped: keep the value as extra information only.
"Person" fields describe an individual recruiter/HR contact. "Row" fields describe the company or the hiring event.
Columns about students, coordinators, schedules, CTC/salary, dates, statuses or checkboxes are not person fields: use unmapped or ignore.
Return one suggestion per input column.`,
    prompt: JSON.stringify(ambiguous.slice(0, 120)),
    schema: AI_SCHEMA,
    temperature: 0.1,
  });
  const valid = (result.suggestions || []).filter(
    (s) => ambiguous.some((a) => a.sheet === s.sheet && a.column_index === s.column_index),
  );
  audit('import', imp.id, 'ai_mapping_suggested', { columns: ambiguous.length, suggestions: valid.length });
  res.json({ suggestions: valid.map((s) => ({ ...s, field: s.field === 'unmapped' ? null : s.field })) });
});

export default router;
