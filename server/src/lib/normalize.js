const EMAIL_VALID = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;
const EMAIL_FIND = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const NULLISH = new Set(['', '-', '--', 'na', 'n/a', 'n.a.', 'nil', 'null', 'none', 'nan', 'undefined', '#n/a', 'not available']);

export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'rediffmail.com', 'proton.me', 'protonmail.com',
  'zoho.com', 'zohomail.in', 'gmx.com', 'mail.com', 'yandex.com',
]);

const COMPANY_SUFFIXES = /\b(private limited|pvt\.? ltd\.?|pvt|ltd|limited|inc|incorporated|llc|llp|corp|corporation|co|plc|gmbh)\b\.?/g;

const EXCEL_ERROR = /^#(REF|VALUE|N\/A|NAME\?|DIV\/0|NULL|NUM|SPILL|CALC)!?$/i;

export function cleanText(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value)
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (NULLISH.has(s.toLowerCase()) || EXCEL_ERROR.test(s)) return null;
  return s || null;
}

/** Student / roll-number style addresses such as 23ab0123@college.ac.in. */
export const ROLL_NUMBER_EMAIL = /^\d{2}[a-z]{1,4}\d{3,5}@/i;

const TITLE_WORDS = new Set([
  'hr', 'h.r', 'h.r.', 'executive', 'manager', 'head', 'recruiter', 'recruitment', 'lead', 'director', 'founder', 'co-founder',
  'ceo', 'cto', 'coo', 'vp', 'talent', 'acquisition', 'marketing', 'sales', 'partner', 'associate', 'senior', 'sr', 'sr.',
  'specialist', 'consultant', 'officer', 'coordinator', 'admin', 'ta', 'campus', 'hiring', 'generalist', 'business',
  'operations', 'people', 'gm', 'agm', 'dgm', 'president', 'principal', 'chief', 'team', '-', '|', '(',
]);

/** Splits "Prerna Singh HR Executive" into name and trailing title. */
export function splitNameTitle(value) {
  const s = cleanText(value)?.replace(/\bco[\s-]+founder\b/i, 'Co-Founder');
  if (!s) return { name: null, title: null };
  const paren = s.match(/^(.*?)(?:\s*[(\[]\s*|\s+[-–]\s*)([^)\]]+)[)\]]?$/);
  if (paren && paren[1].split(' ').length <= 4 && /[a-z]/i.test(paren[2])) {
    const tail = paren[2].toLowerCase().split(/\s+/);
    if (tail.some((w) => TITLE_WORDS.has(w))) return { name: paren[1].trim(), title: paren[2].trim() };
  }
  const words = s.split(' ');
  const idx = words.findIndex((w, i) => i >= 1 && TITLE_WORDS.has(w.toLowerCase()));
  if (idx >= 1) return { name: words.slice(0, idx).join(' '), title: words.slice(idx).join(' ') };
  return { name: s, title: null };
}

export function extractEmails(value) {
  const s = cleanText(value);
  if (!s) return [];
  const found = s.replace(/^mailto:/i, '').replace(/\s*@\s*/g, '@').match(EMAIL_FIND) || [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/^[.'-]+|[.'-]+$/g, '')))];
}

export function isValidEmail(email) {
  return !!email && email.length <= 254 && EMAIL_VALID.test(email) && !email.includes('..');
}

export function emailDomain(email) {
  return email?.split('@')[1]?.toLowerCase() || null;
}

export function isFreeDomain(email) {
  return FREE_EMAIL_DOMAINS.has(emailDomain(email));
}

export function normalizePhone(value) {
  let s = cleanText(value);
  if (!s) return null;
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d(\.\d+)?e\+\d+$/i.test(s)) s = Number(s).toFixed(0);
  return s;
}

export function phoneKey(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
}

export function smartCase(value) {
  const s = cleanText(value);
  if (!s) return null;
  const letters = s.replace(/[^a-z]/gi, '');
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    return s.toLowerCase().replace(/(^|[\s'.-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }
  return s;
}

export function normKey(value) {
  const s = cleanText(value);
  return s ? s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || null : null;
}

export function companyKey(value) {
  const s = cleanText(value);
  if (!s) return null;
  return (
    s
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(COMPANY_SUFFIXES, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() || null
  );
}

export function companyFromDomain(email) {
  const domain = emailDomain(email);
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null;
  const parts = domain.split('.');
  let base = parts.length > 2 && ['co', 'com', 'org', 'net', 'ac'].includes(parts.at(-2)) ? parts.at(-3) : parts.at(-2);
  if (!base) return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function firstName(name) {
  const s = cleanText(name);
  if (!s) return null;
  const parts = s.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '').split(' ');
  return parts[0] || null;
}

export function sameValue(a, b) {
  return normKey(a) === normKey(b);
}
