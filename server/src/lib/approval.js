import crypto from 'node:crypto';
import { q, now } from '../db.js';

/**
 * Hash of everything that determines what the recipient receives. Any change to recipient,
 * subject, body or the attached file (by content) yields a different hash.
 */
export function contentHash(draft, resume) {
  const payload = {
    to: (draft.to_email || '').trim().toLowerCase(),
    subject: draft.subject || '',
    body: draft.body || '',
    kind: draft.kind,
    parent: draft.parent_draft_id || null,
    attachment: draft.kind === 'follow_up' || !resume ? null : { sha256: resume.file_hash, filename: draft.attachment_name },
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function resumeForDraft(draft) {
  return draft.resume_id ? q.get('SELECT * FROM resumes WHERE id = ?', draft.resume_id) : null;
}

export function revokeApprovals(draftId, reason) {
  const res = q.run(
    'UPDATE approvals SET revoked_at = ?, revoked_reason = ? WHERE draft_id = ? AND revoked_at IS NULL',
    now(),
    reason,
    draftId,
  );
  return Number(res.changes);
}

/** Returns { valid, approval, reason } for the draft's current content. */
export function approvalState(draft) {
  const approval = q.get(
    'SELECT * FROM approvals WHERE draft_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1',
    draft.id,
  );
  if (!approval) {
    const last = q.get('SELECT * FROM approvals WHERE draft_id = ? ORDER BY id DESC LIMIT 1', draft.id);
    return { valid: false, approval: null, reason: last ? `Previous approval revoked (${last.revoked_reason})` : 'Not approved' };
  }
  if (approval.version !== draft.version) {
    return { valid: false, approval, reason: `Approval is for version ${approval.version}, current version is ${draft.version}` };
  }
  const hash = contentHash(draft, resumeForDraft(draft));
  if (hash !== approval.content_hash) {
    return { valid: false, approval, reason: 'Content changed after approval' };
  }
  return { valid: true, approval, reason: null };
}

/** Reasons the recipient must not be emailed regardless of approval. */
export function contactBlockers(draft, recruiter) {
  const reasons = [];
  if (!recruiter) return ['Recipient no longer exists'];
  if (recruiter.do_not_contact) reasons.push('Contact is marked do-not-contact');
  if (recruiter.contact_status === 'opted_out') reasons.push('Contact opted out');
  if (recruiter.contact_status === 'bounced' || recruiter.email_status === 'bounced') reasons.push('A previous email to this contact bounced');
  if (['invalid', 'missing', 'no_mx'].includes(recruiter.email_status)) reasons.push(`Email address is ${recruiter.email_status.replace('_', ' ')}`);
  if ((recruiter.email_normalized || '').toLowerCase() !== draft.to_email.toLowerCase()) {
    reasons.push("Draft recipient no longer matches the contact's email address");
  }

  if (draft.kind === 'initial') {
    const previous = q.get(
      `SELECT d.id, d.sent_at FROM email_drafts d
       WHERE d.status = 'sent' AND d.id != ? AND lower(d.to_email) = lower(?) ORDER BY d.sent_at DESC LIMIT 1`,
      draft.id,
      draft.to_email,
    );
    if (previous && !draft.override_reason) {
      reasons.push(`Already contacted on ${previous.sent_at?.slice(0, 10)} (add an override reason to allow a repeat)`);
    }
  } else {
    if (recruiter.contact_status === 'replied') reasons.push('Contact already replied; follow-ups stop after a reply');
    const parent = draft.parent_draft_id ? q.get('SELECT status FROM email_drafts WHERE id = ?', draft.parent_draft_id) : null;
    if (!parent || parent.status !== 'sent') reasons.push('The original email has not been sent');
  }
  return reasons;
}

/** Full pre-send check. Returns a list of human-readable blockers; empty means sendable. */
export function sendBlockers(draft) {
  const reasons = [];
  if (!['approved', 'failed'].includes(draft.status)) reasons.push(`Status is "${draft.status}", not approved`);
  const state = approvalState(draft);
  if (!state.valid) reasons.push(state.reason);
  const sent = q.get("SELECT id FROM send_attempts WHERE draft_id = ? AND is_test = 0 AND status = 'sent' LIMIT 1", draft.id);
  if (sent) reasons.push('This email was already sent');
  const pending = q.get(
    "SELECT id FROM send_attempts WHERE draft_id = ? AND is_test = 0 AND status IN ('in_progress', 'unknown') LIMIT 1",
    draft.id,
  );
  if (pending) reasons.push('A previous send attempt has an unknown outcome; reconcile it first');
  const resume = resumeForDraft(draft);
  if (draft.kind === 'initial' && !resume) reasons.push('Resume attachment is missing');
  const recruiter = q.get('SELECT * FROM recruiters WHERE id = ?', draft.recruiter_id);
  reasons.push(...contactBlockers(draft, recruiter));
  return reasons;
}
