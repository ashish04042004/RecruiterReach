import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { RESUMES_DIR } from '../config.js';
import { q, tx, now, parseJson, audit } from '../db.js';
import { analyzeResume, extractResumeText, RESUME_MIME } from '../lib/resume.js';
import { geminiConfigured } from '../lib/gemini.js';
import { httpError, requireId } from '../lib/http.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function serialize(r, { withText = false } = {}) {
  return {
    id: r.id,
    label: r.label,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    fileHash: r.file_hash,
    fileSize: r.file_size,
    profile: parseJson(r.profile_json),
    analysisError: r.analysis_error,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    usage: {
      campaigns: q.get('SELECT COUNT(*) AS n FROM campaigns WHERE resume_id = ?', r.id).n,
      drafts: q.get('SELECT COUNT(*) AS n FROM email_drafts WHERE resume_id = ?', r.id).n,
    },
    ...(withText ? { text: r.text_content } : {}),
  };
}

function load(id) {
  const r = q.get('SELECT * FROM resumes WHERE id = ?', requireId(id));
  if (!r) throw httpError(404, 'Resume not found');
  return r;
}

async function runAnalysis(r) {
  try {
    const profile = await analyzeResume({ text: r.text_content, buffer: fs.readFileSync(r.stored_path), mimeType: r.mime_type });
    const existing = parseJson(r.profile_json);
    if (existing?.target_roles?.length && existing.__edited) profile.target_roles = existing.target_roles;
    if (existing?.preferred_locations?.length && existing.__edited) profile.preferred_locations = existing.preferred_locations;
    q.run('UPDATE resumes SET profile_json = ?, analysis_error = NULL, updated_at = ? WHERE id = ?', profile, now(), r.id);
    audit('resume', r.id, 'analyzed', null);
  } catch (err) {
    q.run('UPDATE resumes SET analysis_error = ?, updated_at = ? WHERE id = ?', err.message, now(), r.id);
  }
}

router.get('/', (req, res) => {
  res.json(q.all('SELECT * FROM resumes ORDER BY is_default DESC, id DESC').map((r) => serialize(r)));
});

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a PDF or DOCX resume');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mime = RESUME_MIME[ext];
  if (!mime) throw httpError(400, 'Resume must be a .pdf or .docx file');
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const duplicate = q.get('SELECT id, label FROM resumes WHERE file_hash = ?', hash);
  if (duplicate) throw httpError(409, `This exact file is already stored as "${duplicate.label}"`);

  const stored = path.join(RESUMES_DIR, `${hash.slice(0, 20)}${ext}`);
  fs.writeFileSync(stored, req.file.buffer, { flag: 'wx' });
  let text = '';
  try {
    text = await extractResumeText(req.file.buffer, ext);
  } catch (err) {
    text = '';
  }
  const isFirst = !q.get('SELECT id FROM resumes LIMIT 1');
  const label = (req.body.label || '').trim() || path.basename(req.file.originalname, ext);
  const ts = now();
  const result = q.run(
    `INSERT INTO resumes (label, original_filename, stored_path, mime_type, file_hash, file_size, text_content, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    label, req.file.originalname, stored, mime, hash, req.file.size, text, isFirst, ts, ts,
  );
  const id = Number(result.lastInsertRowid);
  audit('resume', id, 'uploaded', { filename: req.file.originalname, sha256: hash });
  if (geminiConfigured()) await runAnalysis(load(id));
  else q.run('UPDATE resumes SET analysis_error = ? WHERE id = ?', 'GEMINI_API_KEY is not set; add it and click Analyze.', id);
  res.status(201).json(serialize(load(id), { withText: true }));
});

router.get('/:id', (req, res) => res.json(serialize(load(req.params.id), { withText: true })));

router.get('/:id/file', (req, res) => {
  const r = load(req.params.id);
  res.setHeader('Content-Type', r.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.original_filename)}"`);
  res.sendFile(r.stored_path);
});

router.post('/:id/analyze', async (req, res) => {
  const r = load(req.params.id);
  await runAnalysis(r);
  const updated = load(r.id);
  if (updated.analysis_error) throw httpError(502, updated.analysis_error);
  res.json(serialize(updated, { withText: true }));
});

router.patch('/:id', (req, res) => {
  const r = load(req.params.id);
  const { label, profile, isDefault } = req.body || {};
  tx(() => {
    if (label !== undefined) q.run('UPDATE resumes SET label = ?, updated_at = ? WHERE id = ?', String(label).trim() || r.label, now(), r.id);
    if (profile !== undefined) {
      if (typeof profile !== 'object' || Array.isArray(profile)) throw httpError(400, 'Profile must be an object');
      q.run('UPDATE resumes SET profile_json = ?, updated_at = ? WHERE id = ?', { ...profile, __edited: true }, now(), r.id);
      audit('resume', r.id, 'profile_edited', null);
    }
    if (isDefault) {
      q.run('UPDATE resumes SET is_default = 0');
      q.run('UPDATE resumes SET is_default = 1 WHERE id = ?', r.id);
    }
  });
  res.json(serialize(load(r.id), { withText: true }));
});

router.delete('/:id', (req, res) => {
  const r = load(req.params.id);
  const used = q.get('SELECT (SELECT COUNT(*) FROM campaigns WHERE resume_id = ?) + (SELECT COUNT(*) FROM email_drafts WHERE resume_id = ?) AS n', r.id, r.id).n;
  if (used) throw httpError(409, 'This resume is used by campaigns or drafts and is kept for the audit trail.');
  q.run('DELETE FROM resumes WHERE id = ?', r.id);
  fs.rmSync(r.stored_path, { force: true });
  audit('resume', r.id, 'deleted', null);
  res.json({ ok: true });
});

export default router;
