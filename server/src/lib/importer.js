import { q, tx, now, parseJson } from '../db.js';
import {
  cleanText, companyFromDomain, companyKey, isFreeDomain, isValidEmail, normKey, normalizePhone, phoneKey, smartCase,
} from './normalize.js';

const MERGE_FIELDS = ['name', 'company', 'phone', 'designation', 'location', 'linkedin', 'website', 'notes'];

function normalizeRecord(rec) {
  const f = rec.fields;
  const validEmails = rec.emails.filter(isValidEmail);
  const primary = validEmails[0] || null;
  const values = {
    name: smartCase(f.name),
    company: cleanText(f.company),
    phone: normalizePhone(f.phone),
    designation: cleanText(f.designation),
    location: cleanText(f.location),
    linkedin: cleanText(f.linkedin),
    website: cleanText(f.website),
    notes: cleanText(f.notes),
    job_role: cleanText(f.job_role),
  };
  const extra = { ...rec.extra };
  let companySource = rec.companySource;
  if (!values.company && primary && rec.inferCompanyFromDomain) {
    const inferred = companyFromDomain(primary);
    if (inferred) {
      values.company = inferred;
      companySource = 'email domain';
    }
  }
  if (companySource && companySource !== 'column') extra['Company inferred from'] = companySource;
  const altEmails = rec.emails.filter((e) => e !== primary);
  const rawEmail = primary || rec.emails[0] || rec.invalidEmailValues[0] || null;
  const emailStatus = primary ? 'unchecked' : rawEmail ? 'invalid' : 'missing';
  return { values, primary, altEmails, rawEmail, emailStatus, extra, companySource };
}

function findExisting(n) {
  if (n.primary) return q.get('SELECT * FROM recruiters WHERE email_normalized = ?', n.primary);
  const nk = normKey(n.values.name);
  const ck = companyKey(n.values.company);
  if (nk && ck) {
    const hit = q.get('SELECT * FROM recruiters WHERE name_key = ? AND company_key = ? ORDER BY id LIMIT 1', nk, ck);
    if (hit) return hit;
  }
  const pk = phoneKey(n.values.phone);
  if (pk) return q.get('SELECT * FROM recruiters WHERE phone_key = ? ORDER BY id LIMIT 1', pk);
  return null;
}

function unionList(existing, incoming) {
  const items = (existing || '').split(/\s*;\s*/).filter(Boolean);
  if (incoming && !items.some((i) => normKey(i) === normKey(incoming))) items.push(incoming);
  return items.length ? items.join('; ') : null;
}

function valuesDiffer(field, a, b) {
  if (field === 'phone') return phoneKey(a) !== phoneKey(b);
  return normKey(a) !== normKey(b);
}

/**
 * Merges extracted rows into the recruiters table. With dryRun, everything runs inside a
 * transaction that is rolled back, so the preview uses exactly the same logic as the real import.
 */
export function commitRecords(importId, records, { dryRun = false } = {}) {
  return tx(
    () => {
      const ts = now();
      const createdIds = new Set();
      const summary = {
        rowsProcessed: records.length,
        created: 0,
        mergedWithinImport: 0,
        mergedWithExisting: 0,
        conflicts: 0,
        invalidEmails: 0,
        missingEmails: 0,
        companyInferred: 0,
      };
      const samples = [];

      for (const rec of records) {
        const n = normalizeRecord(rec);
        if (n.emailStatus === 'invalid') summary.invalidEmails++;
        if (n.emailStatus === 'missing') summary.missingEmails++;
        if (n.companySource && n.companySource !== 'column') summary.companyInferred++;
        const sourceLabel = `${rec.source.sheet.trim()} · row ${rec.source.row}${rec.source.group ? ` · ${rec.source.group}` : ''}`;

        const existing = findExisting(n);
        let recruiterId;
        let action;

        if (!existing) {
          const res = q.run(
            `INSERT INTO recruiters (name, email, email_normalized, company, phone, designation, location, linkedin, website, notes,
               job_roles, name_key, company_key, phone_key, extra_json, conflicts_json, email_status, is_free_domain, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
            n.values.name, n.rawEmail, n.primary, n.values.company, n.values.phone, n.values.designation, n.values.location,
            n.values.linkedin, n.values.website, n.values.notes, n.values.job_role, normKey(n.values.name), companyKey(n.values.company),
            phoneKey(n.values.phone),
            { ...n.extra, ...(n.altEmails.length ? { 'Alternate emails': n.altEmails.join(', ') } : {}) },
            n.emailStatus, n.primary ? isFreeDomain(n.primary) : false, ts, ts,
          );
          recruiterId = Number(res.lastInsertRowid);
          createdIds.add(recruiterId);
          summary.created++;
          action = 'create';
        } else {
          recruiterId = existing.id;
          action = 'merge';
          if (createdIds.has(existing.id)) summary.mergedWithinImport++;
          else summary.mergedWithExisting++;

          const conflicts = parseJson(existing.conflicts_json, {});
          const updates = {};
          for (const field of MERGE_FIELDS) {
            const incoming = n.values[field];
            if (!incoming) continue;
            if (!existing[field]) {
              updates[field] = incoming;
            } else if (valuesDiffer(field, existing[field], incoming)) {
              const list = conflicts[field] || [{ value: existing[field], source: 'current value' }];
              if (!list.some((c) => !valuesDiffer(field, c.value, incoming))) {
                list.push({ value: incoming, source: sourceLabel });
                summary.conflicts++;
              }
              conflicts[field] = list;
            }
          }
          const extra = parseJson(existing.extra_json, {});
          for (const [k, v] of Object.entries(n.extra)) if (!(k in extra)) extra[k] = v;
          if (n.altEmails.length) {
            const alts = new Set((extra['Alternate emails'] || '').split(/,\s*/).filter(Boolean));
            n.altEmails.forEach((e) => e !== existing.email_normalized && alts.add(e));
            if (alts.size) extra['Alternate emails'] = [...alts].join(', ');
          }
          const merged = { ...existing, ...updates, job_roles: unionList(existing.job_roles, n.values.job_role) };
          q.run(
            `UPDATE recruiters SET name = ?, company = ?, phone = ?, designation = ?, location = ?, linkedin = ?, website = ?,
               notes = ?, job_roles = ?, name_key = ?, company_key = ?, phone_key = ?, extra_json = ?, conflicts_json = ?, updated_at = ?
             WHERE id = ?`,
            merged.name, merged.company, merged.phone, merged.designation, merged.location, merged.linkedin, merged.website,
            merged.notes, merged.job_roles, normKey(merged.name), companyKey(merged.company), phoneKey(merged.phone), extra,
            conflicts, ts, recruiterId,
          );
        }

        q.run(
          'INSERT INTO recruiter_sources (recruiter_id, import_id, sheet_name, row_number, contact_group, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          recruiterId, importId, rec.source.sheet, rec.source.row, rec.source.group || null, rec.source.raw, ts,
        );

        if (samples.length < 40) {
          samples.push({
            action,
            recruiterId,
            sheet: rec.source.sheet,
            row: rec.source.row,
            group: rec.source.group,
            name: n.values.name,
            jobRole: n.values.job_role,
            email: n.rawEmail,
            emailStatus: n.emailStatus,
            company: n.values.company,
            companySource: n.companySource,
            designation: n.values.designation,
            phone: n.values.phone,
            location: n.values.location,
          });
        }
      }
      summary.uniqueContactsTouched = createdIds.size + summary.mergedWithExisting;
      return { summary, samples };
    },
    { rollback: dryRun },
  );
}
