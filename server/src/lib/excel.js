import * as XLSX from 'xlsx';
import { ROLL_NUMBER_EMAIL, cleanText, emailDomain, extractEmails, splitNameTitle } from './normalize.js';

export const FIELDS = [
  { key: 'name', label: 'Person: full name', scope: 'person' },
  { key: 'first_name', label: 'Person: first name', scope: 'person' },
  { key: 'last_name', label: 'Person: last name', scope: 'person' },
  { key: 'email', label: 'Person: email', scope: 'person' },
  { key: 'phone', label: 'Person: phone', scope: 'person' },
  { key: 'designation', label: "Person: designation", scope: 'person' },
  { key: 'linkedin', label: 'Person: LinkedIn URL', scope: 'person' },
  { key: 'company', label: 'Row: company', scope: 'row' },
  { key: 'job_role', label: 'Row: job role hired for', scope: 'row' },
  { key: 'location', label: 'Row: location', scope: 'row' },
  { key: 'website', label: 'Row: company website', scope: 'row' },
  { key: 'notes', label: 'Row: notes / remarks', scope: 'row' },
  { key: 'ignore', label: 'Ignore column', scope: 'none' },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);
const PERSON_FIELDS = new Set(FIELDS.filter((f) => f.scope === 'person').map((f) => f.key));
const ROW_FIELDS = FIELDS.filter((f) => f.scope === 'row').map((f) => f.key);

const SYNONYMS = {
  name: [
    'name', 'full name', 'hr name', 'hr', 'recruiter', 'recruiter name', 'contact person', 'contact name', 'person',
    'person name', 'hr contact person', 'poc', 'point of contact', 'spoc', 'employee name', 'talent acquisition', 'ta',
    'ta name', 'hiring manager', 'manager name', 'name of hr', 'hr person', 'recruiter s name', 'contact person name',
    'coordinator', 'student coordinator', 'scpt name', 'spoc name',
  ],
  first_name: ['first name', 'firstname', 'fname', 'given name'],
  last_name: ['last name', 'lastname', 'lname', 'surname', 'family name'],
  email: [
    'email', 'mail', 'email id', 'e mail', 'emailid', 'mail id', 'mailid', 'official email', 'official email id',
    'work email', 'email address', 'e mail id', 'contact email', 'hr email', 'hr email id', 'recruiter email',
    'official mail', 'mail address', 'business email', 'corporate email',
  ],
  company: [
    'company', 'organization', 'organisation', 'employer', 'company name', 'org', 'firm', 'account name', 'client',
    'current company', 'companies', 'organization name', 'organisation name', 'employer name', 'final company',
  ],
  phone: [
    'phone', 'mobile', 'contact no', 'contact number', 'phone number', 'mobile number', 'mobile no', 'phone no',
    'cell', 'cell phone', 'telephone', 'tel', 'whatsapp', 'contact', 'mob', 'mob no', 'ph no', 'hr contact',
  ],
  designation: ['designation', 'title', 'job title', 'hr designation', 'current title', 'designation title'],
  job_role: ['job role', 'job profile', 'role', 'profile', 'position', 'post', 'job position', 'opening', 'job opening', 'roles'],
  location: [
    'location', 'city', 'place', 'region', 'country', 'state', 'office location', 'base location', 'work location',
    'job location', 'geography', 'based in', 'hq',
  ],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile', 'profile url', 'linkedin link', 'linked in', 'li url'],
  website: ['website', 'company website', 'domain', 'url', 'web', 'site', 'company url', 'web site'],
  notes: ['notes', 'remarks', 'comment', 'comments', 'note', 'remark'],
  ignore: ['s no', 'sr no', 'sl no', 'serial no', 'serial number', 'sno', 'srno', 'slno', 'no', 'index', 'id', 'sr', 'signature'],
};

const VAGUE_HEADERS = new Set(['contact', 'profile', 'title', 'client', 'domain', 'role', 'post']);

const SYNONYM_LIST = Object.entries(SYNONYMS)
  .flatMap(([field, words]) => words.map((w) => ({ field, word: w })))
  .sort((a, b) => b.word.length - a.word.length);

/** Words describing *which* field a header is, as opposed to *whose* (HR, SCPT, Student...). */
const FIELD_WORDS = new Set([
  'name', 'email', 'mail', 'id', 'e', 'contact', 'no', 'number', 'phone', 'mobile', 'cell', 'designation', 'title',
  'linkedin', 'details', 'detail', 'of', 'address', 's', 'coordinator', 'person', 'num', 'ph', 'mob', 'url', 'profile',
  'first', 'last', 'full', 'given', 'surname', 'official', 'work', 'whatsapp', 'tel', 'telephone',
]);
const STUDENT_PREFIX = /\b(student|students|scpt|spoc|coordinator|volunteer|candidate|college|alumni)\b/i;
const RECRUITING_PREFIX = /\b(hr|recruiter|recruiters|recruitment|talent|ta|hiring|human resources)\b/i;
const STUDENT_SHEET_HEADER = /\b(roll no|admission|cgpa|year of passing|discipline|branch)\b/i;

export function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function headerMatch(header) {
  const h = normalizeHeader(header);
  if (!h || /^column [a-z]+$/.test(h)) return null;
  const exact = SYNONYM_LIST.find((s) => s.word === h);
  if (exact) return { field: exact.field, score: VAGUE_HEADERS.has(h) ? 0.5 : 0.95, word: exact.word };
  const stripped = h.replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim();
  const exactStripped = SYNONYM_LIST.find((s) => s.word === stripped);
  if (exactStripped) return { field: exactStripped.field, score: 0.9, word: exactStripped.word };
  const padded = ` ${h} `;
  const partial = SYNONYM_LIST.find((s) => s.word.length > 2 && padded.includes(` ${s.word} `));
  if (partial) return { field: partial.field, score: 0.7, word: partial.word };
  return null;
}

function headerPrefix(header) {
  const h = normalizeHeader(header);
  if (/^column [a-z]+$/.test(h)) return '';
  return h
    .split(' ')
    .filter((w) => w && !FIELD_WORDS.has(w) && !/^\d+$/.test(w))
    .join(' ');
}

const columnLetter = (i) => XLSX.utils.encode_col(i);

export function readWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: true });
}

/** Rows as arrays of display strings plus the range offset for absolute Excel row/column numbers. */
export function readSheetRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) return { rows: [], rowOffset: 0, colOffset: 0 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
  return { rows, rowOffset: range.s.r, colOffset: range.s.c };
}

const isBlankRow = (row) => !row || row.every((c) => cleanText(c) == null);

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((h) => {
    const count = (seen.get(h) || 0) + 1;
    seen.set(h, count);
    return count > 1 ? `${h} (${count})` : h;
  });
}

function sheetHeaders(rows, headerRowIndex, colOffset) {
  const width = rows.reduce((m, r) => Math.max(m, r?.length || 0), 0);
  const headerRow = headerRowIndex < 0 ? [] : rows[headerRowIndex] || [];
  const original = Array.from({ length: width }, (_, c) => cleanText(headerRow[c]) || `Column ${columnLetter(c + colOffset)}`);
  return { width, original, unique: uniqueHeaders(original) };
}

function detectHeaderRow(rows) {
  let best = { index: -1, score: 0 };
  const limit = Math.min(rows.length, 20);
  for (let r = 0; r < limit; r++) {
    const cells = (rows[r] || []).map(cleanText).filter(Boolean);
    if (cells.length < 2) continue;
    let synonymHits = 0;
    let textCells = 0;
    let penalty = 0;
    for (const c of cells) {
      if (extractEmails(c).length) penalty += 3;
      else if (/^[\d\s+().,:/-]+$/.test(c)) penalty += 1;
      else {
        textCells++;
        if (c.length <= 40 && headerMatch(c)) synonymHits++;
      }
    }
    const score = synonymHits * 3 + textCells - penalty;
    if (score > best.score && (synonymHits >= 1 || textCells >= 3)) best = { index: r, score };
  }
  return best.index;
}

const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

function profileColumn(values) {
  const n = values.length || 1;
  let email = 0, roll = 0, phone = 0, url = 0, linkedin = 0, nameLike = 0, numeric = 0, recruitingTitle = 0;
  const domains = {};
  for (const v of values) {
    const emails = extractEmails(v);
    if (emails.length) {
      email++;
      if (emails.some((e) => ROLL_NUMBER_EMAIL.test(e))) roll++;
      for (const e of emails) {
        const d = emailDomain(e);
        domains[d] = (domains[d] || 0) + 1;
      }
      continue;
    }
    if (/linkedin\.com/i.test(v)) {
      linkedin++;
      continue;
    }
    if (/^(https?:\/\/|www\.)/i.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(v)) url++;
    const digits = v.replace(/\D/g, '');
    if (!DATE_LIKE.test(v) && /^[\d\s+().\-/,]+$/.test(v) && digits.length >= 7 && digits.length <= 36) phone++;
    else if (/^\d+(\.\d+)?$/.test(v)) numeric++;
    if (/^[a-z][a-z.'\- ]{1,40}$/i.test(v) && v.split(' ').length <= 5) nameLike++;
    if (/\b(hr|recruit\w*|talent|acquisition|human resources|people|hiring)\b/i.test(v)) recruitingTitle++;
  }
  return {
    email: email / n,
    roll: email ? roll / email : 0,
    phone: phone / n,
    url: url / n,
    linkedin: linkedin / n,
    nameLike: nameLike / n,
    numeric: numeric / n,
    recruitingTitle: recruitingTitle / n,
    domains,
  };
}

function detectField(header, stats, fillRatio) {
  const hm = headerMatch(header);
  const reasons = [];
  const pct = (x) => `${Math.round(x * 100)}%`;

  if (fillRatio === 0) return { field: 'ignore', confidence: 0.9, reasons: ['column is empty'] };
  if (stats.email >= 0.5) {
    reasons.push(`${pct(stats.email)} of values are email addresses`);
    if (hm && hm.field !== 'email') reasons.push(`header suggested ${hm.field}, overridden by content`);
    return { field: 'email', confidence: 0.98, reasons };
  }
  if (stats.linkedin >= 0.5) return { field: 'linkedin', confidence: 0.95, reasons: [`${pct(stats.linkedin)} of values are LinkedIn URLs`] };
  if (stats.phone >= 0.6 && (!hm || ['phone', 'name', 'notes'].includes(hm.field) || hm.score < 0.9)) {
    reasons.push(`${pct(stats.phone)} of values look like phone numbers`);
    return { field: 'phone', confidence: hm?.field === 'phone' ? 0.97 : 0.8, reasons };
  }
  if (hm) {
    let { field } = hm;
    let confidence = hm.score;
    reasons.push(`header "${header}" matches "${hm.word}"`);
    if (field === 'email' && stats.email < 0.2) {
      confidence = 0.3;
      reasons.push('but few values contain an email address');
    }
    if (field === 'phone' && stats.phone < 0.3) {
      confidence = Math.min(confidence, 0.35);
      reasons.push('but few values look like phone numbers');
    }
    if (field === 'name' && stats.nameLike < 0.4) {
      confidence = Math.min(confidence, 0.5);
      reasons.push('but values do not look like person names');
    }
    if (field === 'designation' && stats.recruitingTitle < 0.2 && /job|title/.test(normalizeHeader(header))) {
      field = 'job_role';
      confidence = 0.6;
      reasons.push('values look like job openings rather than the contact\'s own title');
    }
    if (field === 'website' && stats.url < 0.3) {
      confidence = Math.min(confidence, 0.4);
      reasons.push('but few values are web addresses');
    }
    if (field === 'ignore') confidence = Math.max(confidence, stats.numeric > 0.7 ? 0.95 : 0.6);
    return { field, confidence, reasons };
  }
  if (stats.url >= 0.5) return { field: 'website', confidence: 0.6, reasons: [`${pct(stats.url)} of values are web addresses`] };
  return { field: null, confidence: 0, reasons: ['no matching header or recognizable content'] };
}

/**
 * Splits person-level columns into contact groups. A row like
 * "HR Name, HR Email, HR Contact, HR Name, HR Email, ..., SCPT Name, ..." yields HR #1, HR #2, SCPT #1.
 */
export function computeGroups(columns, fieldByIndex) {
  const groups = [];
  let current = null;
  const prefixCounts = {};
  for (const col of columns) {
    const field = fieldByIndex[col.index];
    if (!PERSON_FIELDS.has(field)) continue;
    const prefix = headerPrefix(col.header);
    const sameFieldPrefix = current?.fieldPrefixes[field];
    const startNew =
      !current ||
      (field === 'name' && current.fields.has('name')) ||
      (prefix && current.prefix && prefix !== current.prefix) ||
      (current.fields.has(field) && (!['email', 'phone'].includes(field) || sameFieldPrefix === prefix));
    if (startNew) {
      const base = prefix || '';
      prefixCounts[base] = (prefixCounts[base] || 0) + 1;
      current = {
        id: `g${groups.length + 1}`,
        prefix: prefix || '',
        label: `${base ? base.toUpperCase() : 'Contact'} #${prefixCounts[base]}`,
        columns: [],
        fields: new Set(),
        fieldPrefixes: {},
      };
      groups.push(current);
    } else if (!current.prefix && prefix && field === 'name') {
      current.prefix = prefix;
    }
    current.columns.push(col.index);
    current.fields.add(field);
    current.fieldPrefixes[field] ??= prefix;
  }

  return groups.map((g) => {
    const cols = columns.filter((c) => g.columns.includes(c.index));
    const emailCols = cols.filter((c) => fieldByIndex[c.index] === 'email');
    const rollRatio = Math.max(0, ...emailCols.map((c) => c.stats?.roll || 0));
    const hasEmails = emailCols.some((c) => c.fillRatio > 0);
    let include = true;
    let reason = null;
    if (STUDENT_PREFIX.test(g.prefix) || STUDENT_PREFIX.test(g.label)) {
      include = false;
      reason = `"${g.prefix}" columns look like student / coordinator contacts`;
    } else if (rollRatio > 0.3) {
      include = false;
      reason = `${Math.round(rollRatio * 100)}% of emails look like student roll numbers`;
    } else if (!hasEmails) {
      reason = 'No email addresses in this group';
    }
    return { id: g.id, label: g.label, prefix: g.prefix, columns: g.columns, include, reason, hasEmails };
  });
}

const GENERIC_SHEET = /^(sheet|tab|page|data|list|copy of)\s*\d*$/i;

export function analyzeSheet(wb, sheetName, headerRowOverride) {
  const { rows, colOffset } = readSheetRows(wb, sheetName);
  const nonBlank = rows.filter((r) => !isBlankRow(r));
  const headerRowIndex = headerRowOverride ?? detectHeaderRow(rows);
  const headerless = headerRowIndex < 0;
  const { width, original } = sheetHeaders(rows, headerRowIndex, colOffset);
  const dataRows = rows.slice(headerless ? 0 : headerRowIndex + 1).filter((r) => !isBlankRow(r));

  const columns = [];
  for (let c = 0; c < width; c++) {
    const header = original[c];
    const values = dataRows.map((r) => cleanText(r[c])).filter(Boolean);
    const fillRatio = dataRows.length ? values.length / dataRows.length : 0;
    const stats = profileColumn(values.slice(0, 400));
    const detected = detectField(headerless ? '' : header, stats, fillRatio);
    columns.push({
      index: c,
      header,
      samples: [...new Set(values)].slice(0, 5).map((v) => (v.length > 80 ? `${v.slice(0, 77)}...` : v)),
      fillRatio: Math.round(fillRatio * 100) / 100,
      stats,
      detected,
      ambiguous: detected.field === null || (detected.confidence < 0.6 && fillRatio > 0),
    });
  }

  const defaultFields = Object.fromEntries(columns.map((c) => [c.index, defaultField(c)]));
  const groups = computeGroups(columns, defaultFields);
  const fields = new Set(Object.values(defaultFields));
  const warnings = [];
  let skip = false;
  let skipReason = null;

  const includedWithEmail = groups.filter((g) => g.include && g.hasEmails);
  if (dataRows.length === 0) {
    skip = true;
    skipReason = 'Sheet is empty';
  } else if (!fields.has('email')) {
    skip = true;
    skipReason = 'No email column detected';
  } else if (!includedWithEmail.length) {
    skip = true;
    skipReason = 'Only student / coordinator contacts were found';
  } else if (columns.some((c) => STUDENT_SHEET_HEADER.test(c.header)) && !fields.has('company')) {
    skip = true;
    skipReason = 'Looks like a student record sheet (roll numbers, CGPA, branch)';
  }
  if (!skip && !fields.has('company')) {
    warnings.push(
      GENERIC_SHEET.test(sheetName.trim())
        ? 'No company column detected. Company will be inferred from corporate email domains.'
        : `No company column detected. Consider using the sheet name "${sheetName.trim()}" as the company if it names one.`,
    );
  }
  if (headerless) warnings.push('No header row detected; columns were identified from their content only.');
  for (const g of groups.filter((x) => !x.include)) warnings.push(`${g.label} excluded: ${g.reason}`);

  return {
    name: sheetName,
    totalRows: nonBlank.length,
    dataRowCount: dataRows.length,
    headerRowIndex,
    headerless,
    headerPreview: rows.slice(0, 8).map((r) => (r || []).slice(0, 14).map((v) => cleanText(v) || '')),
    columns,
    groups,
    suggestedSkip: skip,
    skipReason,
    warnings,
  };
}

function defaultField(col) {
  const { field, confidence } = col.detected;
  if (field === null) return null;
  return confidence >= 0.45 ? field : null;
}

/** Domains whose addresses are overwhelmingly student roll numbers (e.g. the institution's own domain). */
function detectInstitutionDomains(sheets) {
  const rollByDomain = {};
  for (const s of sheets) {
    for (const c of s.columns) {
      if (c.stats.roll > 0.5) {
        for (const [d, n] of Object.entries(c.stats.domains)) rollByDomain[d] = (rollByDomain[d] || 0) + n;
      }
    }
  }
  return Object.entries(rollByDomain)
    .filter(([, n]) => n >= 5)
    .map(([d]) => d);
}

export function analyzeWorkbook(wb) {
  const sheets = wb.SheetNames.map((name) => analyzeSheet(wb, name));
  return { sheets, suggestedExcludedDomains: detectInstitutionDomains(sheets) };
}

export function defaultSheetMapping(sheet) {
  return {
    skip: sheet.suggestedSkip,
    headerRowIndex: sheet.headerRowIndex,
    companyFromSheetName: false,
    inferCompanyFromDomain: true,
    columns: Object.fromEntries(sheet.columns.map((c) => [c.index, defaultField(c)])),
    groupInclude: {},
  };
}

export function defaultMapping(analysis) {
  return {
    excludedDomains: analysis.suggestedExcludedDomains || [],
    sheets: Object.fromEntries(analysis.sheets.map((s) => [s.name, defaultSheetMapping(s)])),
  };
}

/** Groups for a sheet under the current mapping, with user include overrides applied. */
export function resolveGroups(sheet, sheetMapping) {
  const groups = computeGroups(sheet.columns, sheetMapping.columns || {});
  return groups.map((g) => ({ ...g, include: sheetMapping.groupInclude?.[g.id] ?? g.include }));
}

const splitMulti = (value) =>
  (cleanText(value) || '')
    .split(/\s*(?:\/|;|\||\n|,(?=\s*[A-Z+\d]))\s*/)
    .map((v) => cleanText(v))
    .filter(Boolean);

function matchNameToEmail(email, names) {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  return names.find((n) =>
    n
      .toLowerCase()
      .replace(/^(mr|mrs|ms|dr)\.?\s+/, '')
      .split(/[\s.]+/)
      .some((t) => t.length >= 3 && local.includes(t)),
  );
}

/** Turns every mapped row into one record per person, with full traceability to sheet, row and contact group. */
export function extractRecords(wb, analysis, mapping) {
  const records = [];
  const sheetStats = {};
  const excluded = new Set((mapping.excludedDomains || []).map((d) => d.toLowerCase().trim()).filter(Boolean));

  for (const sheet of analysis.sheets) {
    const m = mapping.sheets?.[sheet.name];
    const stats = { rows: 0, records: 0, skippedNoContact: 0, excludedEmails: 0, skipped: !!m?.skip };
    sheetStats[sheet.name] = stats;
    if (!m || m.skip) continue;

    const { rows, rowOffset, colOffset } = readSheetRows(wb, sheet.name);
    const headerIdx = m.headerRowIndex ?? sheet.headerRowIndex;
    const { width, unique: headers } = sheetHeaders(rows, headerIdx, colOffset);
    const fieldOf = (c) => m.columns?.[c] ?? null;
    const groups = resolveGroups(sheet, m);
    const groupedCols = new Set(groups.flatMap((g) => g.columns));
    const includedGroups = groups.filter((g) => g.include);

    for (let i = headerIdx < 0 ? 0 : headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (isBlankRow(row)) continue;
      stats.rows++;

      const rowFields = {};
      const rowExtra = {};
      const rowRaw = {};
      for (let c = 0; c < width; c++) {
        if (groupedCols.has(c)) continue;
        const value = cleanText(row[c]);
        if (!value) continue;
        const field = fieldOf(c);
        if (field === 'ignore') continue;
        rowRaw[headers[c]] = value;
        if (ROW_FIELDS.includes(field) && !rowFields[field]) rowFields[field] = value;
        else if (!PERSON_FIELDS.has(field)) rowExtra[headers[c]] = value;
      }
      let companySource = rowFields.company ? 'column' : null;
      if (!rowFields.company && m.companyFromSheetName) {
        rowFields.company = sheet.name.trim();
        companySource = 'sheet name';
      }

      let rowProducedRecord = false;
      for (const g of includedGroups) {
        const names = [];
        const emails = [];
        const invalidEmailValues = [];
        const phones = [];
        const person = {};
        const groupRaw = {};
        for (const c of g.columns) {
          const value = cleanText(row[c]);
          if (!value) continue;
          groupRaw[headers[c]] = value;
          const field = fieldOf(c);
          if (field === 'name') names.push(...splitMulti(value));
          else if (field === 'email') {
            const found = extractEmails(value);
            if (found.length) emails.push(...found);
            else invalidEmailValues.push(value);
          } else if (field === 'phone') phones.push(...splitMulti(value));
          else person[field] ??= value;
        }
        if (!names.length && (person.first_name || person.last_name)) {
          names.push([person.first_name, person.last_name].filter(Boolean).join(' '));
        }
        if (!Object.keys(groupRaw).length) continue;

        const kept = [...new Set(emails)].filter((e) => {
          const blocked = excluded.has(emailDomain(e)) || ROLL_NUMBER_EMAIL.test(e);
          if (blocked) stats.excludedEmails++;
          return !blocked;
        });
        if (emails.length && !kept.length) continue;
        if (!kept.length && !names.length && !phones.length) continue;

        const people = kept.length ? kept : [null];
        people.forEach((email, idx) => {
          let rawName =
            (email && matchNameToEmail(email, names)) ||
            (names.length === people.length ? names[idx] : people.length === 1 ? names[0] : null) ||
            null;
          const { name, title } = splitNameTitle(rawName);
          const phone = phones.length === people.length ? phones[idx] : idx === 0 ? phones.join(' / ') || null : null;
          records.push({
            fields: {
              ...rowFields,
              name,
              phone,
              designation: person.designation || title,
              linkedin: person.linkedin,
            },
            emails: email ? [email] : [],
            invalidEmailValues: email ? [] : invalidEmailValues,
            extra: { ...rowExtra, ...(RECRUITING_PREFIX.test(g.prefix) ? { 'Listed as': 'HR / recruiting contact' } : {}) },
            companySource,
            inferCompanyFromDomain: m.inferCompanyFromDomain !== false,
            source: { sheet: sheet.name, row: rowOffset + i + 1, group: g.label, raw: { ...rowRaw, ...groupRaw } },
          });
          stats.records++;
          rowProducedRecord = true;
        });
      }
      if (!rowProducedRecord) stats.skippedNoContact++;
    }
  }
  return { records, sheetStats };
}
