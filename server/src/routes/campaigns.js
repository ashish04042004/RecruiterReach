import { Router } from 'express';
import { q, tx, now, parseJson, audit } from '../db.js';
import { httpError, listFromText, requireId, toInt } from '../lib/http.js';
import { scoreRecruiter } from '../lib/scoring.js';
import { STYLES, generateDraft } from '../lib/drafting.js';
import { startJob, mapLimit } from '../lib/jobs.js';
import { approvalState, sendBlockers } from '../lib/approval.js';
import { gmailAccount } from '../lib/gmail.js';
import { sendSettings, sentInLast24h, startBatch } from '../lib/sender.js';
import { buildRecruiterFilter, serializeRecruiter } from './recruiters.js';

const router = Router();

function load(id) {
  const c = q.get('SELECT * FROM campaigns WHERE id = ?', requireId(id));
  if (!c) throw httpError(404, 'Campaign not found');
  return c;
}

function stats(campaignId) {
  const rows = q.all('SELECT status, kind, COUNT(*) AS n FROM email_drafts WHERE campaign_id = ? GROUP BY status, kind', campaignId);
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + r.n;
  const replies = q.get(
    "SELECT COUNT(DISTINCT i.recruiter_id) AS n FROM interactions i JOIN email_drafts d ON d.id = i.draft_id WHERE d.campaign_id = ? AND i.type = 'reply'",
    campaignId,
  ).n;
  const bounces = q.get(
    "SELECT COUNT(DISTINCT i.recruiter_id) AS n FROM interactions i JOIN email_drafts d ON d.id = i.draft_id WHERE d.campaign_id = ? AND i.type = 'bounce'",
    campaignId,
  ).n;
  return { byStatus, total: rows.reduce((s, r) => s + r.n, 0), replies, bounces };
}

function serialize(c) {
  const resume = c.resume_id ? q.get('SELECT id, label, original_filename FROM resumes WHERE id = ?', c.resume_id) : null;
  return { ...c, company_research: !!c.company_research, resume, stats: stats(c.id) };
}

function campaignInput(body, existing = {}) {
  const style = body.style ?? existing.style ?? 'concise';
  if (!STYLES[style]) throw httpError(400, 'Unknown style');
  const name = (body.name ?? existing.name ?? '').trim();
  if (!name) throw httpError(400, 'Campaign name is required');
  const resumeId = body.resume_id ?? existing.resume_id ?? null;
  if (resumeId && !q.get('SELECT id FROM resumes WHERE id = ?', resumeId)) throw httpError(400, 'Resume not found');
  return {
    name,
    resume_id: resumeId,
    status: body.status ?? existing.status ?? 'active',
    target_roles: body.target_roles ?? existing.target_roles ?? null,
    target_companies: body.target_companies ?? existing.target_companies ?? null,
    target_locations: body.target_locations ?? existing.target_locations ?? null,
    style,
    custom_instructions: body.custom_instructions ?? existing.custom_instructions ?? null,
    company_research: body.company_research ?? existing.company_research ?? true,
    followup_days: Math.max(1, toInt(body.followup_days ?? existing.followup_days, 6)),
    max_followups: Math.max(0, Math.min(3, toInt(body.max_followups ?? existing.max_followups, 1))),
  };
}

router.get('/', (req, res) => {
  res.json(q.all('SELECT * FROM campaigns ORDER BY status, id DESC').map(serialize));
});

router.post('/', (req, res) => {
  const v = campaignInput(req.body || {});
  const ts = now();
  const result = q.run(
    `INSERT INTO campaigns (name, resume_id, status, target_roles, target_companies, target_locations, style, custom_instructions,
       company_research, followup_days, max_followups, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.name, v.resume_id, v.status, v.target_roles, v.target_companies, v.target_locations, v.style, v.custom_instructions,
    v.company_research, v.followup_days, v.max_followups, ts, ts,
  );
  const id = Number(result.lastInsertRowid);
  audit('campaign', id, 'created', v);
  res.status(201).json(serialize(load(id)));
});

router.get('/:id', (req, res) => res.json(serialize(load(req.params.id))));

router.patch('/:id', (req, res) => {
  const c = load(req.params.id);
  const v = campaignInput(req.body || {}, c);
  q.run(
    `UPDATE campaigns SET name = ?, resume_id = ?, status = ?, target_roles = ?, target_companies = ?, target_locations = ?, style = ?,
       custom_instructions = ?, company_research = ?, followup_days = ?, max_followups = ?, updated_at = ? WHERE id = ?`,
    v.name, v.resume_id, v.status, v.target_roles, v.target_companies, v.target_locations, v.style, v.custom_instructions,
    v.company_research, v.followup_days, v.max_followups, now(), c.id,
  );
  audit('campaign', c.id, 'updated', v);
  res.json(serialize(load(c.id)));
});

function targetsOf(c) {
  return {
    companies: listFromText(c.target_companies),
    locations: listFromText(c.target_locations),
    roles: listFromText(c.target_roles),
  };
}

/** Ranked candidate list with eligibility flags, for recipient selection. */
router.get('/:id/candidates', (req, res) => {
  const c = load(req.params.id);
  const { where, params } = buildRecruiterFilter(req.query);
  const rows = q.all(
    `SELECT r.*,
       (SELECT COUNT(*) FROM recruiter_sources s WHERE s.recruiter_id = r.id) AS source_count,
       (SELECT group_concat(DISTINCT trim(s.sheet_name)) FROM recruiter_sources s WHERE s.recruiter_id = r.id) AS sheets,
       (SELECT d.id FROM email_drafts d WHERE d.recruiter_id = r.id AND d.campaign_id = ? AND d.kind = 'initial') AS in_campaign_draft_id,
       (SELECT MAX(d.sent_at) FROM email_drafts d WHERE lower(d.to_email) = lower(r.email_normalized) AND d.status = 'sent') AS previously_sent_at
     FROM recruiters r ${where}`,
    c.id, ...params,
  );
  const targets = targetsOf(c);
  const includeIneligible = req.query.includeIneligible === 'true';
  const minScore = toInt(req.query.minScore, 0);
  const scored = rows
    .map((r) => {
      const { score, reasons } = scoreRecruiter(r, targets);
      const blockers = [];
      if (r.do_not_contact) blockers.push('Do not contact');
      if (r.contact_status === 'opted_out') blockers.push('Opted out');
      if (r.contact_status === 'bounced' || r.email_status === 'bounced') blockers.push('Bounced before');
      if (['invalid', 'missing', 'no_mx'].includes(r.email_status)) blockers.push(`Email ${r.email_status.replace('_', ' ')}`);
      const warnings = [];
      if (r.previously_sent_at) warnings.push(`Already contacted ${r.previously_sent_at.slice(0, 10)}`);
      if (r.contact_status === 'replied') warnings.push('Has replied before');
      return { ...serializeRecruiter(r), score, reasons, blockers, warnings, inCampaign: !!r.in_campaign_draft_id };
    })
    .filter((r) => r.score >= minScore && (includeIneligible || (!r.blockers.length && !r.inCampaign)))
    .sort((a, b) => b.score - a.score || (a.company || '').localeCompare(b.company || ''));

  const page = Math.max(1, toInt(req.query.page, 1));
  const pageSize = Math.min(500, Math.max(10, toInt(req.query.pageSize, 100)));
  res.json({ total: scored.length, page, pageSize, items: scored.slice((page - 1) * pageSize, page * pageSize) });
});

router.post('/:id/recipients', (req, res) => {
  const c = load(req.params.id);
  const ids = [...new Set((req.body.recruiterIds || []).map(Number).filter(Boolean))];
  const overrideReason = (req.body.overrideReason || '').trim() || null;
  if (!ids.length) throw httpError(400, 'Select at least one contact');
  if (!c.resume_id) throw httpError(400, 'Choose a resume for this campaign first');
  const resume = q.get('SELECT * FROM resumes WHERE id = ?', c.resume_id);
  const targets = targetsOf(c);
  const added = [];
  const skipped = [];

  tx(() => {
    for (const id of ids) {
      const r = q.get('SELECT * FROM recruiters WHERE id = ?', id);
      if (!r) {
        skipped.push({ id, reason: 'Contact not found' });
        continue;
      }
      const label = r.name || r.email || `#${id}`;
      if (r.do_not_contact || r.contact_status === 'opted_out') {
        skipped.push({ id, name: label, reason: 'Do not contact / opted out' });
        continue;
      }
      if (!r.email_normalized || ['invalid', 'missing', 'no_mx', 'bounced'].includes(r.email_status)) {
        skipped.push({ id, name: label, reason: 'No deliverable email address' });
        continue;
      }
      if (q.get("SELECT id FROM email_drafts WHERE campaign_id = ? AND recruiter_id = ? AND kind = 'initial'", c.id, id)) {
        skipped.push({ id, name: label, reason: 'Already in this campaign' });
        continue;
      }
      const prev = q.get(
        "SELECT sent_at FROM email_drafts WHERE lower(to_email) = lower(?) AND status = 'sent' ORDER BY sent_at DESC LIMIT 1",
        r.email_normalized,
      );
      if (prev && !overrideReason) {
        skipped.push({ id, name: label, reason: `Already contacted on ${prev.sent_at.slice(0, 10)}; provide an override reason to include` });
        continue;
      }
      const { score, reasons } = scoreRecruiter(r, targets);
      const ts = now();
      const result = q.run(
        `INSERT INTO email_drafts (campaign_id, recruiter_id, kind, to_email, resume_id, attachment_name, status, relevance_score,
           relevance_reasons_json, override_reason, created_at, updated_at) VALUES (?, ?, 'initial', ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        c.id, id, r.email_normalized, resume.id, resume.original_filename, score, reasons, prev ? overrideReason : null, ts, ts,
      );
      added.push(Number(result.lastInsertRowid));
    }
    if (added.length) audit('campaign', c.id, 'recipients_added', { count: added.length, overrideReason });
  });
  res.json({ added: added.length, draftIds: added, skipped });
});

router.post('/:id/generate', (req, res) => {
  const c = load(req.params.id);
  const requested = (req.body.draftIds || []).map(Number).filter(Boolean);
  const drafts = requested.length
    ? q.all(`SELECT id FROM email_drafts WHERE campaign_id = ? AND id IN (${requested.map(() => '?').join(',')}) AND status IN ('queued', 'draft', 'skipped')`, c.id, ...requested)
    : q.all("SELECT id FROM email_drafts WHERE campaign_id = ? AND status = 'queued' ORDER BY relevance_score DESC", c.id);
  if (!drafts.length) throw httpError(400, 'No queued drafts to generate');
  const job = startJob('generate_drafts', drafts.length, async (j) => {
    await mapLimit(drafts, 2, async (d) => {
      try {
        await generateDraft(d.id);
        j.done++;
      } catch (err) {
        j.failed++;
        j.errors.push(`Draft ${d.id}: ${err.message}`);
        j.done++;
      }
    });
  });
  res.json(job);
});

/** Everything the final confirmation screen needs: what will be sent and what is blocked, and why. */
router.get('/:id/send-preview', (req, res) => {
  const c = load(req.params.id);
  const drafts = q.all(
    `SELECT d.*, r.name AS recruiter_name, r.company AS recruiter_company
     FROM email_drafts d JOIN recruiters r ON r.id = d.recruiter_id
     WHERE d.campaign_id = ? AND d.status IN ('approved', 'failed') ORDER BY d.relevance_score DESC, d.id`,
    c.id,
  );
  const ready = [];
  const blocked = [];
  for (const d of drafts) {
    const reasons = sendBlockers(d);
    const item = {
      id: d.id, kind: d.kind, to: d.to_email, name: d.recruiter_name, company: d.recruiter_company, subject: d.subject,
      attachment: d.attachment_name, status: d.status, approvedAt: approvalState(d).approval?.approved_at || null,
    };
    if (reasons.length) blocked.push({ ...item, reasons });
    else ready.push(item);
  }
  const s = sendSettings();
  res.json({
    ready,
    blocked,
    gmail: gmailAccount(),
    dailyLimit: s.dailyLimit,
    sentLast24h: sentInLast24h(),
    delaySeconds: s.delaySeconds,
    unknownAttempts: q.get("SELECT COUNT(*) AS n FROM send_attempts WHERE status = 'unknown' AND is_test = 0").n,
  });
});

router.post('/:id/send', (req, res) => {
  const c = load(req.params.id);
  const draftIds = [...new Set((req.body.draftIds || []).map(Number).filter(Boolean))];
  const { confirmCount, confirmText } = req.body || {};
  if (!draftIds.length) throw httpError(400, 'No emails selected');
  if (Number(confirmCount) !== draftIds.length) throw httpError(400, 'Confirmation count does not match the number of selected emails');
  if (String(confirmText || '').trim().toUpperCase() !== `SEND ${draftIds.length}`) {
    throw httpError(400, `Type "SEND ${draftIds.length}" to confirm`);
  }
  if (!gmailAccount()) throw httpError(400, 'Gmail is not connected');
  const running = q.get("SELECT id FROM send_batches WHERE status = 'running' LIMIT 1");
  if (running) throw httpError(409, `Batch #${running.id} is still running; pause or wait for it to finish first`);

  const batchId = tx(() => {
    const problems = [];
    for (const id of draftIds) {
      const d = q.get('SELECT * FROM email_drafts WHERE id = ? AND campaign_id = ?', id, c.id);
      if (!d) {
        problems.push(`Draft ${id} is not part of this campaign`);
        continue;
      }
      const reasons = sendBlockers(d);
      if (reasons.length) problems.push(`${d.to_email}: ${reasons.join('; ')}`);
    }
    if (problems.length) throw httpError(409, 'Some emails are not sendable. Refresh and review.', { problems });
    const result = q.run(
      "INSERT INTO send_batches (campaign_id, draft_ids_json, total, status, confirmed_at) VALUES (?, ?, ?, 'running', ?)",
      c.id, draftIds, draftIds.length, now(),
    );
    const id = Number(result.lastInsertRowid);
    audit('batch', id, 'confirmed', { campaignId: c.id, count: draftIds.length, draftIds });
    return id;
  });
  startBatch(batchId);
  res.status(201).json({ batchId });
});

export default router;
