import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'analyzed',
  analysis_json TEXT NOT NULL,
  mapping_json TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS recruiters (
  id INTEGER PRIMARY KEY,
  name TEXT,
  email TEXT,
  email_normalized TEXT UNIQUE,
  company TEXT,
  phone TEXT,
  designation TEXT,
  location TEXT,
  linkedin TEXT,
  website TEXT,
  notes TEXT,
  job_roles TEXT,
  name_key TEXT,
  company_key TEXT,
  phone_key TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  conflicts_json TEXT NOT NULL DEFAULT '{}',
  email_status TEXT NOT NULL DEFAULT 'unchecked',
  email_checked_at TEXT,
  is_free_domain INTEGER NOT NULL DEFAULT 0,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  contact_status TEXT NOT NULL DEFAULT 'new',
  last_contacted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruiters_namecompany ON recruiters(name_key, company_key);
CREATE INDEX IF NOT EXISTS idx_recruiters_phone ON recruiters(phone_key);
CREATE INDEX IF NOT EXISTS idx_recruiters_company ON recruiters(company_key);

CREATE TABLE IF NOT EXISTS recruiter_sources (
  id INTEGER PRIMARY KEY,
  recruiter_id INTEGER NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  import_id INTEGER REFERENCES imports(id),
  sheet_name TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  contact_group TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_recruiter ON recruiter_sources(recruiter_id);

CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  text_content TEXT,
  profile_json TEXT,
  analysis_error TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  website TEXT,
  careers_url TEXT,
  summary TEXT,
  facts_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  researched_at TEXT
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  resume_id INTEGER REFERENCES resumes(id),
  status TEXT NOT NULL DEFAULT 'active',
  target_roles TEXT,
  target_companies TEXT,
  target_locations TEXT,
  style TEXT NOT NULL DEFAULT 'concise',
  custom_instructions TEXT,
  company_research INTEGER NOT NULL DEFAULT 1,
  followup_days INTEGER NOT NULL DEFAULT 6,
  max_followups INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_drafts (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  recruiter_id INTEGER NOT NULL REFERENCES recruiters(id),
  kind TEXT NOT NULL DEFAULT 'initial',
  parent_draft_id INTEGER REFERENCES email_drafts(id),
  followup_number INTEGER NOT NULL DEFAULT 0,
  to_email TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  resume_id INTEGER REFERENCES resumes(id),
  attachment_name TEXT,
  rationale TEXT,
  personalization_json TEXT NOT NULL DEFAULT '{}',
  quality_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  version INTEGER NOT NULL DEFAULT 0,
  relevance_score INTEGER,
  relevance_reasons_json TEXT NOT NULL DEFAULT '[]',
  override_reason TEXT,
  generation_error TEXT,
  model TEXT,
  sent_at TEXT,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  rfc_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, recruiter_id, kind, followup_number)
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON email_drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_recruiter ON email_drafts(recruiter_id);

CREATE TABLE IF NOT EXISTS draft_revisions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES email_drafts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  subject TEXT,
  body TEXT,
  to_email TEXT,
  resume_id INTEGER,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES email_drafts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_draft ON approvals(draft_id);

CREATE TABLE IF NOT EXISTS send_batches (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id),
  draft_ids_json TEXT NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  status_reason TEXT,
  results_json TEXT NOT NULL DEFAULT '{}',
  confirmed_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS send_attempts (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER REFERENCES email_drafts(id),
  batch_id INTEGER REFERENCES send_batches(id),
  approval_id INTEGER REFERENCES approvals(id),
  content_hash TEXT,
  to_email TEXT NOT NULL,
  subject TEXT,
  rfc_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  provider_thread_id TEXT,
  error TEXT,
  response_json TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_draft ON send_attempts(draft_id);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY,
  recruiter_id INTEGER NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES email_drafts(id),
  type TEXT NOT NULL,
  details TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT UNIQUE,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interactions_recruiter ON interactions(recruiter_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
`);

const statementCache = new Map();
function stmt(sql) {
  let s = statementCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statementCache.set(sql, s);
  }
  return s;
}

function bind(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p !== null && typeof p === 'object' && !(p instanceof Uint8Array)) return JSON.stringify(p);
    return p;
  });
}

export const q = {
  get: (sql, ...params) => stmt(sql).get(...bind(params)),
  all: (sql, ...params) => stmt(sql).all(...bind(params)),
  run: (sql, ...params) => stmt(sql).run(...bind(params)),
};

let txDepth = 0;
export function tx(fn, { rollback = false } = {}) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (err) {
    txDepth--;
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => new Date().toISOString();

export function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function getSetting(key, fallback = null) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? parseJson(row.value, fallback) : fallback;
}

export function setSetting(key, value) {
  if (value === undefined || value === null) {
    q.run('DELETE FROM settings WHERE key = ?', key);
    return;
  }
  q.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export function audit(entityType, entityId, action, details = null) {
  q.run(
    'INSERT INTO audit_log (entity_type, entity_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)',
    entityType,
    entityId ?? null,
    action,
    details == null ? null : JSON.stringify(details),
    now(),
  );
}
