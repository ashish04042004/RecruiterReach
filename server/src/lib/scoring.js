import { parseJson } from '../db.js';
import { companyKey, emailDomain, normKey } from './normalize.js';

const RECRUITER_TITLE = /\b(recruit\w*|talent|acquisition|\bta\b|hr|human resources?|people (ops|operations|partner)|hiring|staffing|sourc\w*)\b/i;
const HIRING_MANAGER = /\b(engineering manager|head of engineering|vp engineering|director of engineering|cto|founder|co-founder|tech lead|team lead)\b/i;
const NON_HIRING = /\b(sales|marketing|finance|accounts?|payroll|admin|legal|procurement)\b/i;

/**
 * Deterministic relevance score (0-100) with human-readable reasons.
 * `targets` holds the campaign's lists of target companies, locations and roles.
 */
export function scoreRecruiter(r, targets) {
  let score = 30;
  const reasons = [];
  const add = (points, reason) => {
    score += points;
    reasons.push({ points, reason });
  };

  if (r.email_status === 'valid') add(15, 'Email domain verified');
  else if (r.email_status === 'unchecked') add(5, 'Email syntax valid (domain not yet verified)');
  else if (r.email_status === 'invalid' || r.email_status === 'no_mx' || r.email_status === 'bounced') add(-60, 'Email is not deliverable');
  else if (r.email_status === 'missing') add(-60, 'No email address');

  const title = r.designation || '';
  const listedAs = parseJson(r.extra_json, {})?.['Listed as'] || (typeof r.extra === 'object' ? r.extra?.['Listed as'] : null);
  if (RECRUITER_TITLE.test(title)) add(25, `Role "${title}" is recruiting / HR`);
  else if (HIRING_MANAGER.test(title)) add(15, `Role "${title}" is a likely hiring manager`);
  else if (title && NON_HIRING.test(title)) add(-10, `Role "${title}" is unlikely to hire engineers`);
  else if (listedAs) add(20, 'Listed in an HR contact column of your tracker');
  else if (!title) add(-3, 'No designation on record');

  if (r.name) add(5, 'Named contact allows a personal greeting');
  else add(-5, 'No contact name');

  if (r.company) {
    add(5, 'Company known');
    const ck = companyKey(r.company);
    if (targets.companies.length && targets.companies.some((c) => companyKey(c) === ck || (ck && ck.includes(companyKey(c))))) {
      add(25, `${r.company} is a target company`);
    }
    const domain = emailDomain(r.email_normalized);
    if (domain && ck && domain.replace(/[^a-z0-9]/g, '').includes(ck.split(' ')[0])) add(5, 'Email domain matches company');
  }

  if (r.is_free_domain) add(-5, 'Personal email domain');

  if (targets.locations.length && r.location) {
    const loc = normKey(r.location) || '';
    if (targets.locations.some((l) => loc.includes(normKey(l)))) add(10, `Location ${r.location} matches preferences`);
  }

  if (targets.roles.length && r.job_roles) {
    const hired = normKey(r.job_roles) || '';
    const roleWords = targets.roles.flatMap((role) => (normKey(role) || '').split(' ')).filter((w) => w.length > 2 && !['and', 'the'].includes(w));
    const hit = roleWords.find((w) => new RegExp(`\\b${w}\\b`).test(hired));
    if (hit) add(10, `Company hired for "${r.job_roles.slice(0, 60)}" (matches your target roles)`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}
