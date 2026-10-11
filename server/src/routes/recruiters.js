import { Router } from 'express';
import { q, tx, now, parseJson, audit } from '../db.js';
import { checkDomain } from '../lib/emailcheck.js';
import { httpError, requireId, toInt } from '../lib/http.js';
import { startJob, mapLimit } from '../lib/jobs.js';
import {
  cleanText, companyKey, emailDomain, extractEmails, isFreeDomain, isValidEmail, normKey, normalizePhone, phoneKey,
} from '../lib/normalize.js';
import { revokeApprovals } from '../lib/approval.js';

const router = Router();

const SORTS = {
  name: 'r.name COLLATE NOCASE',
  company: 'r.company COLLATE NOCASE',
  updated: 'r.updated_at DESC',
  contacted: 'r.last_contacted_at DESC',
};

export function serializeRecruiter(r) {
  return {
    ...r,
    extra: parseJson(r.extra_json, {}),
    conflicts: parseJson(r.conflicts_json, {}),
    extra_json: undefined,
    conflicts_json: undefined,
    do_not_contact: !!r.do_not_contact,
    is_free_domain: !!r.is_free_domain,
  };
}

export function buildRecruiterFilter(query) {
  const where = [];
  const params = [];
  if (query.q) {
    const like = `%${String(query.q).trim()}%`;
    where.push('(r.name LIKE ? OR r.email LIKE ? OR r.company LIKE ? OR r.designation LIKE ? OR r.job_roles LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (query.company) {
    where.push('r.company_key = ?');
    params.push(companyKey(query.company));
  }
  if (query.emailStatus) {
    const list = String(query.emailStatus).split(',');
    where.push(`r.email_status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (query.contactStatus) {
    const list = String(query.contactStatus).split(',');
    where.push(`r.contact_status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (query.sheet) {
    where.push('EXISTS (SELECT 1 FROM recruiter_sources s WHERE s.recruiter_id = r.id AND s.sheet_name = ?)');
    params.push(query.sheet);
  }
  if (query.location) {
    where.push('r.location LIKE ?');
    params.push(`%${query.location}%`);
  }
  if (query.hasConflicts === 'true') where.push("r.conflicts_json != '{}'");
  if (query.multiSource === 'true') where.push('(SELECT COUNT(DISTINCT s.sheet_name) FROM recruiter_sources s WHERE s.recruiter_id = r.id) > 1');
  if (query.dnc === 'true') where.push('r.do_not_contact = 1');
  if (query.dnc === 'false') where.push('r.do_not_contact = 0');
  if (query.freeDomain === 'false') where.push('r.is_free_domain = 0');
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/', (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const pageSize = Math.min(200, Math.max(10, toInt(req.query.pageSize, 50)));
  const { where, params } = buildRecruiterFilter(req.query);
  const order = SORTS[req.query.sort] || SORTS.company;
  const total = q.get(`SELECT COUNT(*) AS n FROM recruiters r ${where}`, ...params).n;
  const rows = q.all(
    `SELECT r.*,
       (SELECT COUNT(*) FROM recruiter_sources s WHERE s.recruiter_id = r.id) AS source_count,
       (SELECT group_concat(DISTINCT trim(s.sheet_name)) FROM recruiter_sources s WHERE s.recruiter_id = r.id) AS sheets
     FROM recruiters r ${where} ORDER BY ${order}, r.id LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );
  res.json({ total, page, pageSize, items: rows.map(serializeRecruiter) });
});

router.get('/facets', (req, res) => {
  res.json({
    sheets: q.all('SELECT trim(sheet_name) AS name, sheet_name AS value, COUNT(DISTINCT recruiter_id) AS count FROM recruiter_sources GROUP BY sheet_name ORDER BY sheet_name'),
    companies: q.all('SELECT company AS name, COUNT(*) AS count FROM recruiters WHERE company IS NOT NULL GROUP BY company_key ORDER BY count DESC, company LIMIT 300'),
    emailStatus: q.all('SELECT email_status AS name, COUNT(*) AS count FROM recruiters GROUP BY email_status'),
    contactStatus: q.all('SELECT contact_status AS name, COUNT(*) AS count FROM recruiters GROUP BY contact_status'),
    total: q.get('SELECT COUNT(*) AS n FROM recruiters').n,
    withConflicts: q.get("SELECT COUNT(*) AS n FROM recruiters WHERE conflicts_json != '{}'").n,
    multiSource: q.get('SELECT COUNT(*) AS n FROM (SELECT recruiter_id FROM recruiter_sources GROUP BY recruiter_id HAVING COUNT(DISTINCT sheet_name) > 1)').n,
  });
});

router.get('/:id', (req, res) => {
  const id = requireId(req.params.id);
  const r = q.get('SELECT * FROM recruiters WHERE id = ?', id);
  if (!r) throw httpError(404, 'Contact not found');
  res.json({
    recruiter: serializeRecruiter(r),
    sources: q
      .all('SELECT * FROM recruiter_sources WHERE recruiter_id = ? ORDER BY id', id)
      .map((s) => ({ ...s, raw: parseJson(s.raw_json, {}), raw_json: undefined })),
    drafts: q.all(
      `SELECT d.id, d.campaign_id, c.name AS campaign_name, d.kind, d.subject, d.status, d.sent_at, d.followup_number
       FROM email_drafts d JOIN campaigns c ON c.id = d.campaign_id WHERE d.recruiter_id = ? ORDER BY d.id DESC`,
      id,
    ),
    interactions: q.all('SELECT * FROM interactions WHERE recruiter_id = ? ORDER BY occurred_at DESC', id),
  });
});

const EDITABLE = ['name', 'company', 'phone', 'designation', 'location', 'linkedin', 'website', 'notes', 'job_roles'];

function retargetUnsentDrafts(recruiterId, newEmail) {
  const drafts = q.all(
    "SELECT * FROM email_drafts WHERE recruiter_id = ? AND status NOT IN ('sent', 'sending', 'unknown')",
    recruiterId,
  );
  for (const d of drafts) {
    const version = d.version + 1;
    const status = d.status === 'approved' ? 'draft' : d.status;
    q.run('UPDATE email_drafts SET to_email = ?, version = ?, status = ?, updated_at = ? WHERE id = ?', newEmail, version, status, now(), d.id);
    q.run(
      "INSERT INTO draft_revisions (draft_id, version, subject, body, to_email, resume_id, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, 'recipient_changed', ?, ?)",
      d.id, version, d.subject, d.body, newEmail, d.resume_id, `Recipient changed from ${d.to_email}`, now(),
    );
    revokeApprovals(d.id, 'recipient changed');
  }
}

router.patch('/:id', (req, res) => {
  const id = requireId(req.params.id);
  const result = tx(() => {
    const r = q.get('SELECT * FROM recruiters WHERE id = ?', id);
    if (!r) throw httpError(404, 'Contact not found');
    const body = req.body || {};
    const next = { ...r };
    const changes = {};
    const conflicts = parseJson(r.conflicts_json, {});

    for (const f of EDITABLE) {
      if (f in body) {
        const v = f === 'phone' ? normalizePhone(body[f]) : cleanText(body[f]);
        if (v !== r[f]) changes[f] = { from: r[f], to: v };
        next[f] = v;
      }
    }
    if (body.resolveConflict) {
      const { field, value } = body.resolveConflict;
      if (!EDITABLE.includes(field)) throw httpError(400, 'Invalid conflict field');
      if (value !== undefined) {
        next[field] = cleanText(value);
        changes[field] = { from: r[field], to: next[field], via: 'conflict resolution' };
      }
      delete conflicts[field];
    }
    if ('do_not_contact' in body) {
      next.do_not_contact = body.do_not_contact ? 1 : 0;
      if (next.do_not_contact !== r.do_not_contact) changes.do_not_contact = { from: !!r.do_not_contact, to: !!next.do_not_contact };
    }
    if ('email' in body) {
      const raw = cleanText(body.email);
      const email = extractEmails(raw)[0] || null;
      if (raw && !isValidEmail(email)) throw httpError(400, 'That email address is not valid');
      if (email !== r.email_normalized) {
        const clash = email && q.get('SELECT id, name FROM recruiters WHERE email_normalized = ? AND id != ?', email, id);
        if (clash) throw httpError(409, `Another contact (#${clash.id} ${clash.name || ''}) already uses ${email}`);
        next.email = email;
        next.email_normalized = email;
        next.email_status = email ? 'unchecked' : 'missing';
        next.is_free_domain = email && isFreeDomain(email) ? 1 : 0;
        changes.email = { from: r.email, to: email };
        if (email) retargetUnsentDrafts(id, email);
      }
    }
    if ('email_status' in body && ['valid', 'unchecked', 'invalid', 'no_mx', 'bounced'].includes(body.email_status)) {
      next.email_status = body.email_status;
      changes.email_status = { from: r.email_status, to: body.email_status };
    }

    q.run(
      `UPDATE recruiters SET name = ?, email = ?, email_normalized = ?, company = ?, phone = ?, designation = ?, location = ?,
         linkedin = ?, website = ?, notes = ?, job_roles = ?, name_key = ?, company_key = ?, phone_key = ?, conflicts_json = ?,
         email_status = ?, is_free_domain = ?, do_not_contact = ?, updated_at = ? WHERE id = ?`,
      next.name, next.email, next.email_normalized, next.company, next.phone, next.designation, next.location,
      next.linkedin, next.website, next.notes, next.job_roles, normKey(next.name), companyKey(next.company),
      phoneKey(next.phone), conflicts, next.email_status, next.is_free_domain, next.do_not_contact, now(), id,
    );
    if (Object.keys(changes).length) audit('recruiter', id, 'edited', changes);
    return q.get('SELECT * FROM recruiters WHERE id = ?', id);
  });
  res.json(serializeRecruiter(result));
});

router.post('/bulk', (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action;
  if (!ids.length) throw httpError(400, 'Select at least one contact');
  if (!['dnc', 'undnc'].includes(action)) throw httpError(400, 'Unknown action');
  tx(() => {
    for (const id of ids) {
      q.run('UPDATE recruiters SET do_not_contact = ?, updated_at = ? WHERE id = ?', action === 'dnc' ? 1 : 0, now(), id);
    }
    audit('recruiter', null, action === 'dnc' ? 'bulk_do_not_contact' : 'bulk_allow_contact', { ids });
  });
  res.json({ updated: ids.length });
});

router.post('/:id/opt-out', (req, res) => {
  const id = requireId(req.params.id);
  tx(() => {
    const r = q.get('SELECT id FROM recruiters WHERE id = ?', id);
    if (!r) throw httpError(404, 'Contact not found');
    q.run("UPDATE recruiters SET contact_status = 'opted_out', do_not_contact = 1, updated_at = ? WHERE id = ?", now(), id);
    q.run(
      "INSERT INTO interactions (recruiter_id, type, details, source, occurred_at, created_at) VALUES (?, 'opt_out', ?, 'manual', ?, ?)",
      id, req.body?.details || 'Marked as opted out', now(), now(),
    );
    audit('recruiter', id, 'opted_out', null);
  });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = requireId(req.params.id);
  const sent = q.get("SELECT id FROM email_drafts WHERE recruiter_id = ? AND status IN ('sent', 'sending', 'unknown') LIMIT 1", id);
  if (sent) throw httpError(409, 'This contact has been emailed; keep the record for history (use do-not-contact instead).');
  tx(() => {
    const draftIds = q.all('SELECT id FROM email_drafts WHERE recruiter_id = ?', id).map((d) => d.id);
    for (const d of draftIds) {
      q.run('DELETE FROM send_attempts WHERE draft_id = ?', d);
      q.run('DELETE FROM email_drafts WHERE id = ?', d);
    }
    q.run('DELETE FROM recruiters WHERE id = ?', id);
    audit('recruiter', id, 'deleted', null);
  });
  res.json({ ok: true });
});

router.post('/verify-emails', (req, res) => {
  const rows = q.all("SELECT id, email_normalized FROM recruiters WHERE email_normalized IS NOT NULL AND email_status IN ('unchecked', 'no_mx')");
  const byDomain = new Map();
  for (const r of rows) {
    const d = emailDomain(r.email_normalized);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(r.id);
  }
  const domains = [...byDomain.keys()];
  const job = startJob('verify_emails', domains.length, async (j) => {
    const tally = { valid: 0, no_mx: 0, unchecked: 0 };
    await mapLimit(domains, 8, async (domain) => {
      const status = await checkDomain(domain);
      const ids = byDomain.get(domain);
      tally[status] += ids.length;
      const ts = now();
      for (const id of ids) q.run('UPDATE recruiters SET email_status = ?, email_checked_at = ? WHERE id = ?', status, ts, id);
      j.done++;
    });
    audit('recruiter', null, 'domains_verified', { domains: domains.length, ...tally });
    return tally;
  });
  res.json(job);
});

export default router;
