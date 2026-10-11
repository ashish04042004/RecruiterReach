import { q, now, parseJson, getSetting } from '../db.js';
import { generateGroundedJson } from './gemini.js';
import { companyKey } from './normalize.js';

const SYSTEM = `You research a company for a job seeker writing a short outreach email.
Use Google Search. Report only facts supported by the search results: official website, public careers page,
and a few concise, verifiable facts about what the company builds (products, platforms, engineering domains).
Never speculate about internal openings, hiring plans, team structures or people.
Respond with JSON only, in this shape:
{"official_name": string, "website": string, "careers_url": string, "summary": string (one sentence), "facts": [string, ...up to 4], "confident": boolean}
If you cannot confidently identify the company, set "confident": false and leave the other fields empty.`;

export function serializeCompany(row) {
  if (!row) return null;
  return {
    name: row.name,
    website: row.website,
    careersUrl: row.careers_url,
    summary: row.summary,
    facts: parseJson(row.facts_json, []),
    sources: parseJson(row.sources_json, []),
    error: row.error,
    researchedAt: row.researched_at,
  };
}

export function getCompanyResearch(name) {
  const key = companyKey(name);
  if (!key) return null;
  return serializeCompany(q.get('SELECT * FROM companies WHERE name_key = ?', key));
}

/** Returns cached research when fresh; otherwise runs grounded research and caches the result. */
export async function researchCompany(name, { hint, force = false } = {}) {
  const key = companyKey(name);
  if (!key) return null;
  const ttlDays = Number(getSetting('research_ttl_days', 30));
  const cached = q.get('SELECT * FROM companies WHERE name_key = ?', key);
  if (cached && !force && cached.researched_at) {
    const age = (Date.now() - Date.parse(cached.researched_at)) / 86400000;
    if (age < ttlDays) return serializeCompany(cached);
  }

  let row;
  let researchedAt = now();
  try {
    const prompt = `Company: ${name}${hint ? `\nContext: a contact at this company uses the email domain ${hint}` : ''}`;
    const { data, sources } = await generateGroundedJson({ system: SYSTEM, prompt });
    const confident = data?.confident !== false && (data?.summary || data?.facts?.length);
    row = {
      name: data?.official_name || name,
      website: confident ? data.website || null : null,
      careers_url: confident ? data.careers_url || null : null,
      summary: confident ? data.summary || null : null,
      facts: confident ? (data.facts || []).slice(0, 4) : [],
      sources: sources.slice(0, 6),
      error: confident ? null : 'Company could not be identified with confidence; no company facts will be used.',
    };
  } catch (err) {
    researchedAt = null;
    row = { name, website: null, careers_url: null, summary: null, facts: [], sources: [], error: `Research failed: ${err.message}` };
  }

  q.run(
    `INSERT INTO companies (name_key, name, website, careers_url, summary, facts_json, sources_json, error, researched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, website = excluded.website, careers_url = excluded.careers_url,
       summary = excluded.summary, facts_json = excluded.facts_json, sources_json = excluded.sources_json,
       error = excluded.error, researched_at = excluded.researched_at`,
    key, row.name, row.website, row.careers_url, row.summary, row.facts, row.sources, row.error, researchedAt,
  );
  return getCompanyResearch(name);
}
