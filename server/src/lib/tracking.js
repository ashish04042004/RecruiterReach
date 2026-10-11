import { q, tx, now, audit } from '../db.js';
import { getMessage, getThread, gmailAccount, header, searchMessages } from './gmail.js';
import { httpError } from './http.js';

const BOUNCE_SENDER = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
const OPT_OUT = /\b(unsubscribe|remove me|stop (emailing|contacting|sending)|do not (email|contact)|don't (email|contact)|not interested|opt(ed)? out)\b/i;

function recordInteraction({ recruiterId, draftId, type, details, externalId, occurredAt }) {
  const res = q.run(
    `INSERT OR IGNORE INTO interactions (recruiter_id, draft_id, type, details, source, external_id, occurred_at, created_at)
     VALUES (?, ?, ?, ?, 'gmail_sync', ?, ?, ?)`,
    recruiterId, draftId, type, details, externalId, occurredAt, now(),
  );
  if (!res.changes) return false;
  const status = { reply: 'replied', bounce: 'bounced', opt_out: 'opted_out' }[type];
  if (status === 'opted_out') {
    q.run("UPDATE recruiters SET contact_status = 'opted_out', do_not_contact = 1, updated_at = ? WHERE id = ?", now(), recruiterId);
  } else if (status === 'bounced') {
    q.run("UPDATE recruiters SET contact_status = 'bounced', email_status = 'bounced', updated_at = ? WHERE id = ? AND contact_status != 'opted_out'", now(), recruiterId);
  } else if (status === 'replied') {
    q.run("UPDATE recruiters SET contact_status = 'replied', updated_at = ? WHERE id = ? AND contact_status NOT IN ('opted_out')", now(), recruiterId);
  }
  audit('recruiter', recruiterId, `detected_${type}`, { draftId, externalId });
  return true;
}

/** Looks at the Gmail threads of sent emails for replies and bounces, plus recent delivery-failure notices. */
export async function syncInbox(job) {
  const account = gmailAccount();
  if (!account) throw httpError(400, 'Gmail is not connected');
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const sent = q.all(
    `SELECT id, recruiter_id, to_email, gmail_thread_id, sent_at FROM email_drafts
     WHERE status = 'sent' AND gmail_thread_id IS NOT NULL AND sent_at >= ? ORDER BY sent_at`,
    since,
  );
  const threads = new Map();
  for (const d of sent) {
    if (!threads.has(d.gmail_thread_id)) threads.set(d.gmail_thread_id, []);
    threads.get(d.gmail_thread_id).push(d);
  }
  const summary = { threadsChecked: 0, replies: 0, bounces: 0, optOuts: 0, errors: [] };
  if (job) job.total = threads.size + 1;
  const me = account.email.toLowerCase();

  for (const [threadId, drafts] of threads) {
    try {
      const thread = await getThread(threadId);
      const latest = drafts.at(-1);
      for (const msg of thread.messages || []) {
        const from = header(msg, 'From');
        if (from.toLowerCase().includes(me)) continue;
        const occurredAt = new Date(Number(msg.internalDate)).toISOString();
        const snippet = (msg.snippet || '').slice(0, 500);
        let type = 'reply';
        if (BOUNCE_SENDER.test(from)) type = 'bounce';
        else if (OPT_OUT.test(snippet)) type = 'opt_out';
        const created = tx(() => recordInteraction({ recruiterId: latest.recruiter_id, draftId: latest.id, type, details: `${from}: ${snippet}`, externalId: msg.id, occurredAt }));
        if (created) summary[{ reply: 'replies', bounce: 'bounces', opt_out: 'optOuts' }[type]]++;
      }
    } catch (err) {
      summary.errors.push(`Thread ${threadId}: ${err.message}`);
      if (err.authError) throw err;
    }
    summary.threadsChecked++;
    if (job) job.done++;
  }

  try {
    const bounces = await searchMessages('from:(mailer-daemon OR postmaster) newer_than:60d', 50);
    for (const b of bounces) {
      if (q.get('SELECT id FROM interactions WHERE external_id = ?', b.id)) continue;
      const msg = await getMessage(b.id);
      const text = `${header(msg, 'X-Failed-Recipients')} ${msg.snippet || ''}`.toLowerCase();
      const match = sent.find((d) => text.includes(d.to_email.toLowerCase()));
      if (!match) continue;
      const created = tx(() =>
        recordInteraction({
          recruiterId: match.recruiter_id, draftId: match.id, type: 'bounce', details: (msg.snippet || '').slice(0, 500),
          externalId: b.id, occurredAt: new Date(Number(msg.internalDate)).toISOString(),
        }),
      );
      if (created) summary.bounces++;
    }
  } catch (err) {
    summary.errors.push(`Bounce search: ${err.message}`);
  }
  if (job) job.done++;
  q.run(
    "INSERT INTO settings (key, value) VALUES ('last_sync_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(now()),
  );
  audit('system', null, 'inbox_synced', summary);
  return summary;
}

/** Sent emails whose follow-up window has elapsed without a reply, bounce or opt-out. */
export function dueFollowUps() {
  return q.all(
    `SELECT d.id, d.campaign_id, d.recruiter_id, d.kind, d.followup_number, d.to_email, d.subject, d.sent_at,
       c.name AS campaign_name, c.followup_days, c.max_followups,
       r.name AS recruiter_name, r.company AS recruiter_company, r.contact_status,
       CAST(julianday('now') - julianday(d.sent_at) AS INTEGER) AS days_since
     FROM email_drafts d
     JOIN campaigns c ON c.id = d.campaign_id
     JOIN recruiters r ON r.id = d.recruiter_id
     WHERE d.status = 'sent'
       AND c.status = 'active'
       AND d.followup_number < c.max_followups
       AND julianday('now') - julianday(d.sent_at) >= c.followup_days
       AND r.contact_status = 'contacted'
       AND r.do_not_contact = 0
       AND NOT EXISTS (SELECT 1 FROM email_drafts f WHERE f.parent_draft_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.recruiter_id = d.recruiter_id AND i.type IN ('reply', 'bounce', 'opt_out') AND i.occurred_at >= d.sent_at)
     ORDER BY d.sent_at`,
  );
}

export function createFollowUpDrafts(parentIds) {
  const due = new Map(dueFollowUps().map((d) => [d.id, d]));
  const created = [];
  const skipped = [];
  tx(() => {
    for (const id of parentIds) {
      const parent = due.get(id);
      if (!parent) {
        skipped.push({ id, reason: 'Not due for a follow-up (replied, bounced, opted out, or already followed up)' });
        continue;
      }
      const ts = now();
      const res = q.run(
        `INSERT INTO email_drafts (campaign_id, recruiter_id, kind, parent_draft_id, followup_number, to_email, resume_id, status, created_at, updated_at)
         SELECT campaign_id, recruiter_id, 'follow_up', id, followup_number + 1, to_email, resume_id, 'queued', ?, ? FROM email_drafts WHERE id = ?`,
        ts, ts, id,
      );
      created.push(Number(res.lastInsertRowid));
      audit('draft', Number(res.lastInsertRowid), 'follow_up_created', { parentDraftId: id });
    }
  });
  return { created, skipped };
}
