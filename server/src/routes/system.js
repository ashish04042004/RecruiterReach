import { Router } from 'express';
import { CLIENT_URL, GMAIL_REDIRECT_URI } from '../config.js';
import { q, getSetting, setSetting, parseJson, audit } from '../db.js';
import { DEFAULT_MODEL, geminiConfigured, geminiModel, listModels, generateJsonResult } from '../lib/gemini.js';
import { authUrl, disconnect, gmailAccount, gmailConfigured, handleOAuthCallback } from '../lib/gmail.js';
import { httpError, requireId, toInt } from '../lib/http.js';
import { getJob, startJob } from '../lib/jobs.js';
import { sendCsv } from '../lib/csv.js';
import { researchCompany, getCompanyResearch } from '../lib/research.js';
import { isBatchActive, reconcileUnknown, startBatch, stopBatch } from '../lib/sender.js';
import { createFollowUpDrafts, dueFollowUps, syncInbox } from '../lib/tracking.js';
import { generateDraft } from '../lib/drafting.js';
import { mapLimit } from '../lib/jobs.js';

const router = Router();

// ---------- Settings & status ----------

const SETTING_KEYS = {
  gemini_model: (v) => String(v || '').trim() || null,
  sender_name: (v) => String(v || '').trim(),
  signature: (v) => String(v || ''),
  send_delay_seconds: (v) => Math.max(5, Math.min(600, toInt(v, 45))),
  daily_send_limit: (v) => Math.max(1, Math.min(400, toInt(v, 40))),
  research_ttl_days: (v) => Math.max(1, Math.min(365, toInt(v, 30))),
};

function settingsPayload() {
  return {
    gemini_model: getSetting('gemini_model', ''),
    sender_name: getSetting('sender_name', ''),
    signature: getSetting('signature', ''),
    send_delay_seconds: getSetting('send_delay_seconds', 45),
    daily_send_limit: getSetting('daily_send_limit', 40),
    research_ttl_days: getSetting('research_ttl_days', 30),
    status: {
      geminiConfigured: geminiConfigured(),
      defaultModel: DEFAULT_MODEL,
      activeModel: geminiModel(),
      gmailConfigured: gmailConfigured(),
      gmailAccount: gmailAccount(),
      gmailRedirectUri: GMAIL_REDIRECT_URI,
      lastSyncAt: getSetting('last_sync_at'),
    },
  };
}

router.get('/settings', (req, res) => res.json(settingsPayload()));

router.put('/settings', (req, res) => {
  const changed = {};
  for (const [key, normalize] of Object.entries(SETTING_KEYS)) {
    if (key in (req.body || {})) {
      const value = normalize(req.body[key]);
      setSetting(key, value);
      changed[key] = value;
    }
  }
  audit('settings', null, 'updated', changed);
  res.json(settingsPayload());
});

router.get('/gemini/models', async (req, res) => res.json({ models: await listModels() }));

router.post('/gemini/test', async (req, res) => {
  const { data, model } = await generateJsonResult({
    system: 'Reply with JSON.',
    prompt: 'Return {"ok": true}.',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  });
  res.json({ ok: !!data.ok, model });
});

// ---------- Gmail OAuth ----------

router.get('/gmail/auth-url', (req, res) => res.json({ url: authUrl() }));

router.get('/gmail/oauth/callback', async (req, res) => {
  const back = new URL('/settings', CLIENT_URL);
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    const email = await handleOAuthCallback(String(req.query.code || ''), String(req.query.state || ''));
    back.searchParams.set('gmail', 'connected');
    back.searchParams.set('email', email);
  } catch (err) {
    back.searchParams.set('gmail', 'error');
    back.searchParams.set('message', err.message);
  }
  res.redirect(back.toString());
});

router.post('/gmail/disconnect', async (req, res) => {
  await disconnect();
  res.json({ ok: true });
});

// ---------- Jobs ----------

router.get('/jobs/:id', (req, res) => {
  const job = getJob(requireId(req.params.id));
  if (!job) throw httpError(404, 'Job not found (the server may have restarted)');
  res.json(job);
});

// ---------- Companies ----------

router.get('/companies/research', (req, res) => res.json(getCompanyResearch(String(req.query.name || ''))));

router.post('/companies/research', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw httpError(400, 'Company name is required');
  res.json(await researchCompany(name, { force: !!req.body.force }));
});

// ---------- Sending ----------

function serializeBatch(b) {
  const ids = parseJson(b.draft_ids_json, []);
  const results = parseJson(b.results_json, {});
  const counts = { sent: 0, failed: 0, unknown: 0, blocked: 0, limit: 0, pending: 0 };
  for (const id of ids) counts[results[id]?.status || 'pending'] = (counts[results[id]?.status || 'pending'] || 0) + 1;
  return {
    id: b.id,
    campaignId: b.campaign_id,
    campaignName: b.campaign_id ? q.get('SELECT name FROM campaigns WHERE id = ?', b.campaign_id)?.name : null,
    total: b.total,
    status: b.status,
    statusReason: b.status_reason,
    confirmedAt: b.confirmed_at,
    completedAt: b.completed_at,
    active: isBatchActive(b.id),
    counts,
  };
}

router.get('/send/batches', (req, res) => {
  res.json(q.all('SELECT * FROM send_batches ORDER BY id DESC LIMIT 50').map(serializeBatch));
});

router.get('/send/batches/:id', (req, res) => {
  const b = q.get('SELECT * FROM send_batches WHERE id = ?', requireId(req.params.id));
  if (!b) throw httpError(404, 'Batch not found');
  const ids = parseJson(b.draft_ids_json, []);
  const results = parseJson(b.results_json, {});
  const items = ids.map((id) => {
    const d = q.get(
      `SELECT d.id, d.to_email, d.subject, d.status, d.sent_at, r.name, r.company FROM email_drafts d
       JOIN recruiters r ON r.id = d.recruiter_id WHERE d.id = ?`,
      id,
    );
    return { ...d, result: results[id] || null };
  });
  res.json({ ...serializeBatch(b), items });
});

router.post('/send/batches/:id/:action', (req, res) => {
  const b = q.get('SELECT * FROM send_batches WHERE id = ?', requireId(req.params.id));
  if (!b) throw httpError(404, 'Batch not found');
  const { action } = req.params;
  if (action === 'pause' || action === 'cancel') {
    if (!['running', 'paused'].includes(b.status)) throw httpError(409, `Batch is ${b.status}`);
    stopBatch(b.id, action);
  } else if (action === 'resume') {
    if (b.status !== 'paused') throw httpError(409, 'Only paused batches can be resumed');
    const running = q.get("SELECT id FROM send_batches WHERE status = 'running' AND id != ? LIMIT 1", b.id);
    if (running) throw httpError(409, `Batch #${running.id} is running`);
    audit('batch', b.id, 'resumed', null);
    startBatch(b.id);
  } else {
    throw httpError(400, 'Unknown action');
  }
  res.json(serializeBatch(q.get('SELECT * FROM send_batches WHERE id = ?', b.id)));
});

router.post('/send/reconcile', async (req, res) => res.json(await reconcileUnknown()));

// ---------- Tracking & follow-ups ----------

router.post('/tracking/sync', (req, res) => {
  const job = startJob('sync_inbox', 1, (j) => syncInbox(j));
  res.json(job);
});

router.get('/followups/due', (req, res) => res.json(dueFollowUps()));

router.post('/followups/create', (req, res) => {
  const ids = (req.body.draftIds || []).map(Number).filter(Boolean);
  if (!ids.length) throw httpError(400, 'Select at least one email to follow up');
  const result = createFollowUpDrafts(ids);
  let job = null;
  if (result.created.length && req.body.generate !== false) {
    job = startJob('generate_followups', result.created.length, async (j) => {
      await mapLimit(result.created, 2, async (id) => {
        try {
          await generateDraft(id);
        } catch (err) {
          j.failed++;
          j.errors.push(`Draft ${id}: ${err.message}`);
        }
        j.done++;
      });
    });
  }
  res.json({ ...result, job });
});

router.get('/interactions', (req, res) => {
  const rows = q.all(
    `SELECT i.*, r.name AS recruiter_name, r.company AS recruiter_company, r.email AS recruiter_email
     FROM interactions i JOIN recruiters r ON r.id = i.recruiter_id ORDER BY i.occurred_at DESC LIMIT 300`,
  );
  res.json(rows);
});

router.post('/interactions', (req, res) => {
  const { recruiterId, type, details, draftId } = req.body || {};
  const id = requireId(recruiterId, 'recruiterId');
  if (!['reply', 'bounce', 'opt_out', 'note'].includes(type)) throw httpError(400, 'Unknown interaction type');
  if (!q.get('SELECT id FROM recruiters WHERE id = ?', id)) throw httpError(404, 'Contact not found');
  const ts = new Date().toISOString();
  q.run(
    "INSERT INTO interactions (recruiter_id, draft_id, type, details, source, occurred_at, created_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)",
    id, draftId || null, type, details || null, ts, ts,
  );
  const status = { reply: 'replied', bounce: 'bounced', opt_out: 'opted_out' }[type];
  if (status) {
    q.run(
      `UPDATE recruiters SET contact_status = ?, do_not_contact = CASE WHEN ? = 'opted_out' THEN 1 ELSE do_not_contact END,
         email_status = CASE WHEN ? = 'bounced' THEN 'bounced' ELSE email_status END, updated_at = ? WHERE id = ?`,
      status, status, status, ts, id,
    );
  }
  audit('recruiter', id, `manual_${type}`, { details });
  res.status(201).json({ ok: true });
});

// ---------- Analytics ----------

router.get('/analytics', (req, res) => {
  const one = (sql, ...p) => q.get(sql, ...p).n;
  const contacted = one("SELECT COUNT(DISTINCT recruiter_id) AS n FROM email_drafts WHERE status = 'sent'");
  const replied = one("SELECT COUNT(DISTINCT recruiter_id) AS n FROM interactions WHERE type = 'reply'");
  const totals = {
    contacts: one('SELECT COUNT(*) AS n FROM recruiters'),
    sendable: one("SELECT COUNT(*) AS n FROM recruiters WHERE email_status IN ('valid', 'unchecked') AND do_not_contact = 0 AND contact_status NOT IN ('opted_out', 'bounced')"),
    companies: one('SELECT COUNT(DISTINCT company_key) AS n FROM recruiters WHERE company_key IS NOT NULL'),
    generated: one('SELECT COUNT(*) AS n FROM email_drafts WHERE version > 0'),
    approved: one('SELECT COUNT(DISTINCT draft_id) AS n FROM approvals'),
    sent: one("SELECT COUNT(*) AS n FROM email_drafts WHERE status = 'sent'"),
    followUpsSent: one("SELECT COUNT(*) AS n FROM email_drafts WHERE status = 'sent' AND kind = 'follow_up'"),
    contacted,
    replied,
    bounced: one("SELECT COUNT(DISTINCT recruiter_id) AS n FROM interactions WHERE type = 'bounce'"),
    optedOut: one("SELECT COUNT(*) AS n FROM recruiters WHERE contact_status = 'opted_out'"),
    replyRate: contacted ? Math.round((replied / contacted) * 1000) / 10 : 0,
    pendingReview: one("SELECT COUNT(*) AS n FROM email_drafts WHERE status = 'draft'"),
    readyToSend: one("SELECT COUNT(*) AS n FROM email_drafts WHERE status = 'approved'"),
    followUpsDue: dueFollowUps().length,
  };
  const byCampaign = q.all(
    `SELECT c.id, c.name, c.style,
       SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) AS sent,
       COUNT(DISTINCT CASE WHEN i.type = 'reply' THEN i.recruiter_id END) AS replies,
       COUNT(DISTINCT CASE WHEN i.type = 'bounce' THEN i.recruiter_id END) AS bounces
     FROM campaigns c LEFT JOIN email_drafts d ON d.campaign_id = c.id
     LEFT JOIN interactions i ON i.draft_id = d.id
     GROUP BY c.id ORDER BY c.id DESC`,
  );
  const byStyle = q.all(
    `SELECT c.style, COUNT(DISTINCT d.id) AS sent,
       COUNT(DISTINCT CASE WHEN i.type = 'reply' THEN i.recruiter_id END) AS replies
     FROM email_drafts d JOIN campaigns c ON c.id = d.campaign_id LEFT JOIN interactions i ON i.draft_id = d.id
     WHERE d.status = 'sent' GROUP BY c.style`,
  );
  const byCompany = q.all(
    `SELECT r.company, COUNT(DISTINCT d.id) AS sent,
       COUNT(DISTINCT CASE WHEN i.type = 'reply' THEN i.recruiter_id END) AS replies
     FROM email_drafts d JOIN recruiters r ON r.id = d.recruiter_id LEFT JOIN interactions i ON i.recruiter_id = r.id
     WHERE d.status = 'sent' GROUP BY r.company_key ORDER BY replies DESC, sent DESC LIMIT 25`,
  );
  const bySheet = q.all(
    `SELECT trim(s.sheet_name) AS sheet, COUNT(DISTINCT d.recruiter_id) AS contacted,
       COUNT(DISTINCT CASE WHEN i.type = 'reply' THEN i.recruiter_id END) AS replies
     FROM email_drafts d JOIN recruiter_sources s ON s.recruiter_id = d.recruiter_id
     LEFT JOIN interactions i ON i.recruiter_id = d.recruiter_id
     WHERE d.status = 'sent' GROUP BY s.sheet_name ORDER BY contacted DESC`,
  );
  const daily = q.all(
    `SELECT substr(sent_at, 1, 10) AS day, COUNT(*) AS sent FROM email_drafts
     WHERE status = 'sent' AND sent_at >= date('now', '-30 days') GROUP BY day ORDER BY day`,
  );
  const dailyReplies = q.all(
    `SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS replies FROM interactions
     WHERE type = 'reply' AND occurred_at >= date('now', '-30 days') GROUP BY day`,
  );
  res.json({ totals, byCampaign, byStyle, byCompany, bySheet, daily, dailyReplies });
});

// ---------- Audit & exports ----------

router.get('/audit', (req, res) => {
  const limit = Math.min(1000, toInt(req.query.limit, 200));
  const where = req.query.entityType ? 'WHERE entity_type = ?' : '';
  const params = req.query.entityType ? [req.query.entityType] : [];
  res.json(
    q.all(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`, ...params, limit).map((a) => ({
      ...a,
      details: parseJson(a.details_json),
      details_json: undefined,
    })),
  );
});

router.get('/export/contacts.csv', (req, res) => {
  const rows = q.all(
    `SELECT r.id, r.name, r.email, r.email_status, r.company, r.designation, r.phone, r.location, r.linkedin, r.job_roles,
       r.contact_status, r.do_not_contact, r.last_contacted_at, r.notes,
       (SELECT group_concat(trim(s.sheet_name) || ' row ' || s.row_number || coalesce(' ' || s.contact_group, ''), '; ')
        FROM recruiter_sources s WHERE s.recruiter_id = r.id) AS sources,
       r.conflicts_json AS conflicts
     FROM recruiters r ORDER BY r.company COLLATE NOCASE, r.name`,
  );
  sendCsv(res, 'contacts.csv', rows);
});

router.get('/export/emails.csv', (req, res) => {
  const rows = q.all(
    `SELECT d.id, c.name AS campaign, d.kind, d.followup_number, r.name AS recipient, d.to_email, r.company, d.subject, d.body,
       d.attachment_name, d.status, d.version,
       (SELECT approved_at FROM approvals a WHERE a.draft_id = d.id AND a.revoked_at IS NULL ORDER BY a.id DESC LIMIT 1) AS approved_at,
       (SELECT content_hash FROM approvals a WHERE a.draft_id = d.id AND a.revoked_at IS NULL ORDER BY a.id DESC LIMIT 1) AS approved_hash,
       d.sent_at, d.gmail_message_id, d.gmail_thread_id,
       (SELECT COUNT(*) FROM send_attempts s WHERE s.draft_id = d.id AND s.is_test = 0) AS send_attempts,
       (SELECT error FROM send_attempts s WHERE s.draft_id = d.id AND s.is_test = 0 ORDER BY s.id DESC LIMIT 1) AS last_error
     FROM email_drafts d JOIN campaigns c ON c.id = d.campaign_id JOIN recruiters r ON r.id = d.recruiter_id ORDER BY d.id`,
  );
  sendCsv(res, 'emails.csv', rows);
});

router.get('/export/audit.csv', (req, res) => {
  sendCsv(res, 'audit-log.csv', q.all('SELECT id, created_at, entity_type, entity_id, action, details_json AS details FROM audit_log ORDER BY id'));
});

export default router;
