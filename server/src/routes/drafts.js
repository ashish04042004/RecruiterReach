import { Router } from 'express';
import { q, tx, now, parseJson, audit } from '../db.js';
import { httpError, requireId, toInt } from '../lib/http.js';
import { approvalState, contentHash, resumeForDraft, revokeApprovals, sendBlockers } from '../lib/approval.js';
import { generateDraft, qualityCheck, loadDraftContext } from '../lib/drafting.js';
import { getCompanyResearch } from '../lib/research.js';
import { testSend } from '../lib/sender.js';
import { serializeRecruiter } from './recruiters.js';

const router = Router();

const LOCKED = ['sending', 'sent', 'unknown'];

function serializeDraft(d) {
  return {
    ...d,
    personalization: parseJson(d.personalization_json, {}),
    quality: parseJson(d.quality_json, []),
    relevanceReasons: parseJson(d.relevance_reasons_json, []),
    personalization_json: undefined,
    quality_json: undefined,
    relevance_reasons_json: undefined,
  };
}

function load(id) {
  const d = q.get('SELECT * FROM email_drafts WHERE id = ?', requireId(id));
  if (!d) throw httpError(404, 'Draft not found');
  return d;
}

function detail(id) {
  const { draft, recruiter, campaign, resume } = loadDraftContext(id);
  const state = approvalState(draft);
  return {
    draft: serializeDraft(draft),
    recruiter: recruiter ? serializeRecruiter(recruiter) : null,
    campaign: campaign ? { id: campaign.id, name: campaign.name, style: campaign.style, company_research: !!campaign.company_research } : null,
    resume: resume ? { id: resume.id, label: resume.label, originalFilename: resume.original_filename, fileHash: resume.file_hash } : null,
    approval: { valid: state.valid, reason: state.reason, approvedAt: state.valid ? state.approval.approved_at : null, version: state.approval?.version ?? null },
    sendBlockers: ['approved', 'failed'].includes(draft.status) ? sendBlockers(draft) : [],
    company: recruiter?.company ? getCompanyResearch(recruiter.company) : null,
    parent: draft.parent_draft_id ? q.get('SELECT id, subject, body, sent_at FROM email_drafts WHERE id = ?', draft.parent_draft_id) : null,
    revisions: q.all('SELECT * FROM draft_revisions WHERE draft_id = ? ORDER BY version DESC', draft.id),
    approvals: q.all('SELECT * FROM approvals WHERE draft_id = ? ORDER BY id DESC', draft.id),
    attempts: q.all('SELECT id, status, to_email, is_test, error, provider_message_id, started_at, finished_at FROM send_attempts WHERE draft_id = ? ORDER BY id DESC', draft.id),
  };
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.campaignId) {
    where.push('d.campaign_id = ?');
    params.push(toInt(req.query.campaignId));
  }
  if (req.query.status) {
    const list = String(req.query.status).split(',');
    where.push(`d.status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (req.query.kind) {
    where.push('d.kind = ?');
    params.push(req.query.kind);
  }
  if (req.query.q) {
    const like = `%${req.query.q}%`;
    where.push('(r.name LIKE ? OR r.company LIKE ? OR d.to_email LIKE ? OR d.subject LIKE ?)');
    params.push(like, like, like, like);
  }
  const rows = q.all(
    `SELECT d.id, d.campaign_id, d.recruiter_id, d.kind, d.followup_number, d.to_email, d.subject, d.status, d.version,
       d.relevance_score, d.quality_json, d.generation_error, d.sent_at, d.updated_at,
       r.name AS recruiter_name, r.company AS recruiter_company, r.designation AS recruiter_designation, c.name AS campaign_name
     FROM email_drafts d JOIN recruiters r ON r.id = d.recruiter_id JOIN campaigns c ON c.id = d.campaign_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE d.status WHEN 'draft' THEN 0 WHEN 'failed' THEN 1 WHEN 'unknown' THEN 1 WHEN 'approved' THEN 2 WHEN 'queued' THEN 3 WHEN 'generating' THEN 3 ELSE 4 END,
       d.relevance_score DESC, d.id
     LIMIT 1000`,
    ...params,
  );
  res.json(
    rows.map((r) => {
      const quality = parseJson(r.quality_json, []);
      return {
        ...r,
        quality_json: undefined,
        errors: quality.filter((i) => i.level === 'error').length,
        warnings: quality.filter((i) => i.level === 'warning').length,
        approvalValid: r.status === 'approved' || r.status === 'failed' ? approvalState(load(r.id)).valid : false,
      };
    }),
  );
});

router.get('/:id', (req, res) => res.json(detail(requireId(req.params.id))));

router.patch('/:id', (req, res) => {
  const id = requireId(req.params.id);
  tx(() => {
    const d = load(id);
    if (LOCKED.includes(d.status)) throw httpError(409, 'Sent emails cannot be edited');
    if (d.status === 'queued' || d.status === 'generating') throw httpError(409, 'Generate the draft before editing it');
    const subject = req.body.subject ?? d.subject;
    const body = req.body.body ?? d.body;
    if (subject === d.subject && body === d.body) return;
    if (req.body.baseVersion != null && Number(req.body.baseVersion) !== d.version) {
      throw httpError(409, 'This draft changed since you opened it. Reload to see the latest version.');
    }
    const version = d.version + 1;
    const { recruiter, resume } = loadDraftContext(id);
    const quality = qualityCheck({ subject, body }, { recruiter, profile: parseJson(resume?.profile_json), kind: d.kind, resumeText: resume?.text_content });
    const revoked = revokeApprovals(id, 'edited');
    q.run(
      'UPDATE email_drafts SET subject = ?, body = ?, version = ?, quality_json = ?, status = ?, updated_at = ? WHERE id = ?',
      subject, body, version, quality, d.status === 'approved' ? 'draft' : d.status, now(), id,
    );
    q.run(
      "INSERT INTO draft_revisions (draft_id, version, subject, body, to_email, resume_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'edit', ?)",
      id, version, subject, body, d.to_email, d.resume_id, now(),
    );
    audit('draft', id, 'edited', { version, approvalRevoked: revoked > 0 });
  });
  res.json(detail(id));
});

router.post('/:id/approve', (req, res) => {
  const id = requireId(req.params.id);
  tx(() => {
    const d = load(id);
    if (!['draft', 'failed'].includes(d.status)) throw httpError(409, `Cannot approve a draft with status "${d.status}"`);
    if (Number(req.body.version) !== d.version) {
      throw httpError(409, 'You are approving an outdated version. Reload and review the current content.');
    }
    const quality = parseJson(d.quality_json, []);
    const errors = quality.filter((i) => i.level === 'error');
    if (errors.length) throw httpError(422, `Fix these issues before approving: ${errors.map((e) => e.message).join(' ')}`);
    const resume = resumeForDraft(d);
    if (d.kind === 'initial' && !resume) throw httpError(422, 'The resume attachment is missing');
    revokeApprovals(id, 'superseded');
    const hash = contentHash(d, resume);
    q.run('INSERT INTO approvals (draft_id, version, content_hash, approved_at) VALUES (?, ?, ?, ?)', id, d.version, hash, now());
    q.run("UPDATE email_drafts SET status = 'approved', updated_at = ? WHERE id = ?", now(), id);
    audit('draft', id, 'approved', { version: d.version, contentHash: hash, attachmentSha256: d.kind === 'initial' ? resume.file_hash : null });
  });
  res.json(detail(id));
});

router.post('/:id/unapprove', (req, res) => {
  const id = requireId(req.params.id);
  tx(() => {
    const d = load(id);
    if (d.status !== 'approved' && d.status !== 'failed') throw httpError(409, 'Draft is not approved');
    revokeApprovals(id, 'withdrawn');
    q.run("UPDATE email_drafts SET status = 'draft', updated_at = ? WHERE id = ?", now(), id);
    audit('draft', id, 'approval_withdrawn', null);
  });
  res.json(detail(id));
});

for (const [action, status] of [['skip', 'skipped'], ['reject', 'rejected']]) {
  router.post(`/:id/${action}`, (req, res) => {
    const id = requireId(req.params.id);
    tx(() => {
      const d = load(id);
      if (LOCKED.includes(d.status)) throw httpError(409, 'Sent emails cannot be changed');
      revokeApprovals(id, action);
      q.run('UPDATE email_drafts SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
      audit('draft', id, status, req.body?.reason ? { reason: req.body.reason } : null);
    });
    res.json(detail(id));
  });
}

router.post('/:id/restore', (req, res) => {
  const id = requireId(req.params.id);
  tx(() => {
    const d = load(id);
    if (!['skipped', 'rejected'].includes(d.status)) throw httpError(409, 'Only skipped or rejected drafts can be restored');
    q.run('UPDATE email_drafts SET status = ?, updated_at = ? WHERE id = ?', d.body ? 'draft' : 'queued', now(), id);
    audit('draft', id, 'restored', null);
  });
  res.json(detail(id));
});

router.post('/:id/generate', async (req, res) => {
  const id = requireId(req.params.id);
  await generateDraft(id, { instruction: (req.body?.instruction || '').trim() || undefined });
  res.json(detail(id));
});

router.post('/:id/test-send', async (req, res) => {
  const id = requireId(req.params.id);
  res.json(await testSend(id));
});

router.delete('/:id', (req, res) => {
  const id = requireId(req.params.id);
  tx(() => {
    const d = load(id);
    if (LOCKED.includes(d.status) || q.get('SELECT id FROM send_attempts WHERE draft_id = ? AND is_test = 0 LIMIT 1', id)) {
      throw httpError(409, 'Drafts with send attempts are kept for the audit trail');
    }
    if (q.get('SELECT id FROM email_drafts WHERE parent_draft_id = ? LIMIT 1', id)) throw httpError(409, 'This draft has follow-ups');
    q.run('DELETE FROM send_attempts WHERE draft_id = ?', id);
    q.run('DELETE FROM email_drafts WHERE id = ?', id);
    audit('draft', id, 'removed_from_campaign', { to: d.to_email, campaignId: d.campaign_id });
  });
  res.json({ ok: true });
});

export default router;
