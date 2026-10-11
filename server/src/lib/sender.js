import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { q, tx, now, parseJson, audit, getSetting } from '../db.js';
import { approvalState, resumeForDraft, sendBlockers } from './approval.js';
import {
  buildRawMessage, getMessage, gmailAccount, header, newMessageId, searchMessages, sendRawMessage,
} from './gmail.js';
import { httpError, sleep } from './http.js';

export const sendSettings = () => ({
  dailyLimit: Number(getSetting('daily_send_limit', 40)),
  delaySeconds: Number(getSetting('send_delay_seconds', 45)),
});

export function sentInLast24h() {
  const since = new Date(Date.now() - 86400000).toISOString();
  return q.get(
    "SELECT COUNT(*) AS n FROM send_attempts WHERE is_test = 0 AND status IN ('sent', 'in_progress', 'unknown') AND started_at >= ?",
    since,
  ).n;
}

async function verifiedAttachment(draft) {
  if (draft.kind !== 'initial') return [];
  const resume = resumeForDraft(draft);
  if (!resume) throw new Error('Resume attachment is missing');
  const buffer = await fs.readFile(resume.stored_path);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (hash !== resume.file_hash) throw new Error('Resume file on disk does not match the approved version');
  return [{ filename: draft.attachment_name || resume.original_filename, content: buffer, contentType: resume.mime_type }];
}

function threadReferences(draft) {
  const refs = [];
  let parentId = draft.parent_draft_id;
  let parent = null;
  while (parentId) {
    const p = q.get('SELECT id, parent_draft_id, rfc_message_id, gmail_thread_id FROM email_drafts WHERE id = ?', parentId);
    if (!p) break;
    parent ??= p;
    if (p.rfc_message_id) refs.unshift(p.rfc_message_id);
    parentId = p.parent_draft_id;
  }
  return { parent, references: refs };
}

function fromAddress(account) {
  const name = getSetting('sender_name', '')?.trim();
  return name ? { name, address: account.email } : account.email;
}

/**
 * Sends one approved draft. All approval and eligibility checks are re-run inside a transaction
 * that also reserves the send attempt, so concurrent or repeated calls cannot double-send.
 */
export async function sendDraft(draftId, { batchId = null } = {}) {
  const account = gmailAccount();
  if (!account) throw httpError(400, 'Gmail is not connected.');

  const { draft, attemptId, rfcId } = tx(() => {
    const d = q.get('SELECT * FROM email_drafts WHERE id = ?', draftId);
    if (!d) throw httpError(404, 'Draft not found');
    const blockers = sendBlockers(d);
    if (blockers.length) throw httpError(409, blockers.join('; '), { blockers });
    const { dailyLimit } = sendSettings();
    if (sentInLast24h() >= dailyLimit) throw httpError(429, `Daily send limit of ${dailyLimit} reached. Sending will resume once older sends age out of the 24-hour window.`);
    const state = approvalState(d);
    const id = newMessageId();
    const res = q.run(
      `INSERT INTO send_attempts (draft_id, batch_id, approval_id, content_hash, to_email, subject, rfc_message_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?)`,
      d.id, batchId, state.approval.id, state.approval.content_hash, d.to_email, d.subject, id, now(),
    );
    q.run("UPDATE email_drafts SET status = 'sending', updated_at = ? WHERE id = ?", now(), d.id);
    return { draft: d, attemptId: Number(res.lastInsertRowid), rfcId: id };
  });

  let requestStarted = false;
  try {
    const attachments = await verifiedAttachment(draft);
    const { parent, references } = threadReferences(draft);
    const raw = await buildRawMessage({
      from: fromAddress(account),
      to: draft.to_email,
      subject: draft.subject,
      text: draft.body,
      messageId: rfcId,
      attachments,
      inReplyTo: parent?.rfc_message_id || undefined,
      references: references.length ? references : undefined,
    });
    requestStarted = true;
    const response = await sendRawMessage(raw, parent?.gmail_thread_id || undefined);
    let actualMessageId = rfcId;
    try {
      actualMessageId = header(await getMessage(response.id), 'Message-ID') || rfcId;
    } catch {
      // Non-fatal: threading falls back to the generated Message-ID.
    }
    markSent(draft, attemptId, response, actualMessageId);
    return { status: 'sent', messageId: response.id };
  } catch (err) {
    const definitive = !requestStarted || (err.status >= 400 && err.status < 500);
    const status = definitive ? 'failed' : 'unknown';
    tx(() => {
      q.run(
        'UPDATE send_attempts SET status = ?, error = ?, response_json = ?, finished_at = ? WHERE id = ?',
        status, err.message, err.providerResponse || null, now(), attemptId,
      );
      q.run('UPDATE email_drafts SET status = ?, updated_at = ? WHERE id = ?', status, now(), draft.id);
      audit('draft', draft.id, `send_${status}`, { attemptId, error: err.message });
    });
    return { status, error: err.message, authError: !!err.authError };
  }
}

function markSent(draft, attemptId, response, rfcMessageId) {
  tx(() => {
    const ts = now();
    q.run(
      "UPDATE send_attempts SET status = 'sent', provider_message_id = ?, provider_thread_id = ?, response_json = ?, finished_at = ? WHERE id = ?",
      response.id, response.threadId, response, ts, attemptId,
    );
    q.run(
      "UPDATE email_drafts SET status = 'sent', sent_at = ?, gmail_message_id = ?, gmail_thread_id = ?, rfc_message_id = ?, updated_at = ? WHERE id = ?",
      ts, response.id, response.threadId, rfcMessageId, ts, draft.id,
    );
    q.run(
      `UPDATE recruiters SET contact_status = CASE WHEN contact_status IN ('new', 'contacted') THEN 'contacted' ELSE contact_status END,
         last_contacted_at = ?, updated_at = ? WHERE id = ?`,
      ts, ts, draft.recruiter_id,
    );
    audit('draft', draft.id, 'sent', { attemptId, to: draft.to_email, gmailMessageId: response.id, threadId: response.threadId });
  });
}

/** Sends the draft's exact content to your own address. Does not require or consume approval. */
export async function testSend(draftId) {
  const account = gmailAccount();
  if (!account) throw httpError(400, 'Gmail is not connected.');
  const draft = q.get('SELECT * FROM email_drafts WHERE id = ?', draftId);
  if (!draft?.subject || !draft?.body) throw httpError(400, 'Draft has no content yet.');
  const rfcId = newMessageId();
  const res = q.run(
    `INSERT INTO send_attempts (draft_id, to_email, subject, rfc_message_id, status, is_test, started_at)
     VALUES (?, ?, ?, ?, 'in_progress', 1, ?)`,
    draft.id, account.email, draft.subject, rfcId, now(),
  );
  const attemptId = Number(res.lastInsertRowid);
  try {
    const raw = await buildRawMessage({
      from: fromAddress(account),
      to: account.email,
      subject: `[TEST to ${draft.to_email}] ${draft.subject}`,
      text: draft.body,
      messageId: rfcId,
      attachments: await verifiedAttachment(draft),
    });
    const response = await sendRawMessage(raw);
    q.run(
      "UPDATE send_attempts SET status = 'sent', provider_message_id = ?, provider_thread_id = ?, finished_at = ? WHERE id = ?",
      response.id, response.threadId, now(), attemptId,
    );
    audit('draft', draft.id, 'test_sent', { to: account.email });
    return { sentTo: account.email };
  } catch (err) {
    q.run("UPDATE send_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", err.message, now(), attemptId);
    throw httpError(502, err.message);
  }
}

// ---------- Batches ----------

const activeBatches = new Map();

function saveResults(batchId, results) {
  q.run('UPDATE send_batches SET results_json = ? WHERE id = ?', results, batchId);
}

function finishBatch(batchId, status, reason = null) {
  q.run(
    'UPDATE send_batches SET status = ?, status_reason = ?, completed_at = ? WHERE id = ?',
    status, reason, ['completed', 'cancelled'].includes(status) ? now() : null, batchId,
  );
  audit('batch', batchId, status, reason ? { reason } : null);
}

async function interruptibleSleep(ms, ctl) {
  const end = Date.now() + ms;
  while (Date.now() < end && !ctl.stop) await sleep(Math.min(1000, end - Date.now()));
}

async function runBatch(batchId, ctl) {
  const batch = q.get('SELECT * FROM send_batches WHERE id = ?', batchId);
  const ids = parseJson(batch.draft_ids_json, []);
  const results = parseJson(batch.results_json, {});
  let sentSinceDelay = false;

  for (const id of ids) {
    if (ctl.stop) break;
    if (results[id]?.status === 'sent') continue;
    const current = q.get('SELECT status FROM email_drafts WHERE id = ?', id);
    if (current?.status === 'sent') {
      results[id] = { status: 'sent', note: 'already sent', at: now() };
      saveResults(batchId, results);
      continue;
    }

    if (sentSinceDelay) {
      const { delaySeconds } = sendSettings();
      const jitter = 0.8 + Math.random() * 0.4;
      await interruptibleSleep(delaySeconds * 1000 * jitter, ctl);
      if (ctl.stop) break;
    }

    let outcome;
    try {
      outcome = await sendDraft(id, { batchId });
    } catch (err) {
      outcome = { status: err.status === 429 ? 'limit' : 'blocked', error: err.message, httpStatus: err.status };
    }
    results[id] = { ...outcome, at: now() };
    saveResults(batchId, results);

    if (outcome.status === 'limit') return finishBatch(batchId, 'paused', 'Daily send limit reached');
    if (outcome.authError) return finishBatch(batchId, 'paused', 'Gmail authorization failed; reconnect Gmail and resume');
    if (outcome.httpStatus === 400 && /not connected/i.test(outcome.error)) return finishBatch(batchId, 'paused', outcome.error);
    sentSinceDelay = ['sent', 'failed', 'unknown'].includes(outcome.status);
  }

  if (ctl.stop === 'pause') return finishBatch(batchId, 'paused', 'Paused by you');
  if (ctl.stop === 'cancel') return finishBatch(batchId, 'cancelled', 'Cancelled by you');
  finishBatch(batchId, 'completed');
}

export function startBatch(batchId) {
  if (activeBatches.has(batchId)) return;
  const ctl = { stop: null };
  activeBatches.set(batchId, ctl);
  q.run("UPDATE send_batches SET status = 'running', status_reason = NULL WHERE id = ?", batchId);
  runBatch(batchId, ctl)
    .catch((err) => finishBatch(batchId, 'paused', `Stopped by an error: ${err.message}`))
    .finally(() => activeBatches.delete(batchId));
}

export function stopBatch(batchId, mode) {
  const ctl = activeBatches.get(batchId);
  if (ctl) ctl.stop = mode;
  else finishBatch(batchId, mode === 'cancel' ? 'cancelled' : 'paused', mode === 'cancel' ? 'Cancelled by you' : 'Paused by you');
}

export function isBatchActive(batchId) {
  return activeBatches.has(batchId);
}

// ---------- Recovery ----------

/** Called at startup: anything that was mid-flight when the process died has an unknown outcome. */
export function recoverInterrupted() {
  tx(() => {
    const ts = now();
    const stuck = q.all("SELECT id, draft_id FROM send_attempts WHERE status = 'in_progress' AND is_test = 0");
    for (const a of stuck) {
      q.run("UPDATE send_attempts SET status = 'unknown', error = 'Interrupted before the outcome was recorded' WHERE id = ?", a.id);
      q.run("UPDATE email_drafts SET status = 'unknown', updated_at = ? WHERE id = ? AND status = 'sending'", ts, a.draft_id);
    }
    q.run("UPDATE send_attempts SET status = 'failed', error = 'Interrupted' WHERE status = 'in_progress' AND is_test = 1");
    q.run("UPDATE email_drafts SET status = CASE WHEN body IS NULL THEN 'queued' ELSE 'draft' END WHERE status = 'generating'");
    q.run("UPDATE send_batches SET status = 'paused', status_reason = 'Interrupted by a server restart' WHERE status = 'running'");
    if (stuck.length) audit('system', null, 'recovered_interrupted_sends', { attempts: stuck.map((a) => a.id) });
  });
}

/**
 * Resolves attempts with an unknown outcome by looking for the message in Gmail. Found → sent.
 * Not found → failed, which makes the draft safely retryable.
 */
export async function reconcileUnknown() {
  const attempts = q.all("SELECT * FROM send_attempts WHERE status = 'unknown' AND is_test = 0");
  const summary = { checked: attempts.length, confirmedSent: 0, markedFailed: 0, errors: [] };
  for (const a of attempts) {
    try {
      let hits = await searchMessages(`rfc822msgid:${a.rfc_message_id.replace(/[<>]/g, '')}`, 1);
      if (!hits.length) {
        const after = Math.floor((Date.parse(a.started_at) - 86400000) / 1000);
        const subject = (a.subject || '').replace(/"/g, '');
        hits = await searchMessages(`in:sent to:${a.to_email} subject:"${subject}" after:${after}`, 1);
      }
      const draft = q.get('SELECT * FROM email_drafts WHERE id = ?', a.draft_id);
      if (hits.length) {
        const msg = await getMessage(hits[0].id);
        markSent(draft, a.id, { id: msg.id, threadId: msg.threadId, reconciled: true }, header(msg, 'Message-ID') || a.rfc_message_id);
        summary.confirmedSent++;
      } else {
        tx(() => {
          q.run("UPDATE send_attempts SET status = 'failed', error = 'Not found in Gmail after interruption; safe to retry', finished_at = ? WHERE id = ?", now(), a.id);
          q.run("UPDATE email_drafts SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'unknown'", now(), a.draft_id);
          audit('draft', a.draft_id, 'reconciled_not_sent', { attemptId: a.id });
        });
        summary.markedFailed++;
      }
    } catch (err) {
      summary.errors.push(`Attempt ${a.id}: ${err.message}`);
    }
  }
  return summary;
}
