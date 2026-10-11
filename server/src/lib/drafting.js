import { q, tx, now, parseJson, audit, getSetting } from '../db.js';
import { generateJsonResult } from './gemini.js';
import { httpError, listFromText } from './http.js';
import { emailDomain, firstName, isFreeDomain } from './normalize.js';
import { researchCompany } from './research.js';
import { revokeApprovals } from './approval.js';

export const STYLES = {
  concise: { label: 'Concise', words: [90, 150] },
  standard: { label: 'Standard', words: [140, 200] },
  detailed: { label: 'Detailed', words: [190, 260] },
};
const FOLLOW_UP_WORDS = [40, 100];

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string', description: 'Plain-text email body including greeting and sign-off' },
    rationale: { type: 'string', description: 'One or two sentences explaining the personalization choices' },
    personalization_points: { type: 'array', items: { type: 'string' } },
    profile_facts_used: { type: 'array', items: { type: 'string' }, description: 'Resume facts referenced in the email' },
    company_facts_used: { type: 'array', items: { type: 'string' } },
  },
  required: ['subject', 'body', 'rationale', 'personalization_points', 'profile_facts_used'],
};

const REFERENCE_EMAIL = `Subject: Exploring Software Engineering Opportunities at Acme

Dear Priya,

I hope you're doing well.

I'm currently working as a Software Development Engineer at Example Corp, with experience in software development, C++ and Android technologies.

I'm exploring software engineering opportunities where I can contribute to building scalable, high-quality products. I wanted to reach out to ask whether there are any suitable current or upcoming openings at Acme.

I've attached my resume for your consideration. I'd be grateful if you could point me toward a relevant opportunity or the appropriate hiring team.

Thank you for your time.

Best regards,
Alex Doe`;

function systemPrompt({ style, followUp }) {
  const [min, max] = followUp ? FOLLOW_UP_WORDS : STYLES[style]?.words || STYLES.concise.words;
  return `You write job-search outreach emails on behalf of a candidate, addressed to one recruiter or hiring contact.

Hard rules (never break these):
1. The candidate profile is the only source of truth about the candidate. Never invent or embellish employers, titles, years, skills, metrics, projects or achievements. Use at most 2-3 of the most relevant facts.
2. Never claim or imply an existing relationship, prior conversation, mutual connection, or that someone referred the candidate. You may politely ask whether there are suitable openings, or whether the recipient could point to the right hiring team or consider a referral.
3. Never claim knowledge of specific open positions, team plans or internal information. Do not assume what the recipient's team does beyond their stated designation.
4. Mention company facts only if they are provided under "company_facts", and keep it to one brief, accurate clause. Otherwise do not describe the company.
5. No placeholders such as [Company] or {name}. If the recipient's first name is unknown, greet with "Hello," or "Dear Hiring Team,". If the company is unknown, do not name one.
6. Plain text only: no markdown, no asterisks, no emojis. Short paragraphs separated by one blank line.
7. ${followUp ? 'Do not re-attach or re-pitch at length; briefly reference the earlier email and mention the resume is in that thread.' : 'Mention that the resume is attached.'}
8. Close with a sign-off and the candidate's name, then on following lines any phone number and LinkedIn URL that exist in the profile.
9. Subject line: specific, natural, under 70 characters, no ALL CAPS, no exclamation marks.${followUp ? ' (The subject will be replaced with "Re: <original subject>", so any value is fine.)' : ''}

Style: professional, warm and natural; it must read as written by a person for this one recipient, not mass-generated.
Length: ${min}-${max} words for the body.
${followUp ? '' : `\nReference for tone and structure only (do not copy its facts or names):\n"""\n${REFERENCE_EMAIL}\n"""`}`;
}

function buildPrompt({ recruiter, campaign, profile, company, signature, followUp, instruction }) {
  const payload = {
    recipient: {
      first_name: firstName(recruiter.name),
      full_name: recruiter.name || null,
      designation: recruiter.designation || null,
      company: recruiter.company || null,
      location: recruiter.location || null,
      email_domain: emailDomain(recruiter.email_normalized),
      uses_personal_email: !!isFreeDomain(recruiter.email_normalized),
    },
    campaign: {
      target_roles: listFromText(campaign.target_roles),
      extra_instructions: campaign.custom_instructions || null,
    },
    candidate_profile: profile,
    company_facts: company && !company.error && (company.summary || company.facts?.length)
      ? { summary: company.summary, facts: company.facts }
      : null,
  };
  if (signature) payload.required_signature = signature;
  if (followUp) payload.original_email = { subject: followUp.subject, body: followUp.body, sent_at: followUp.sent_at };

  let text = `${followUp ? 'Write a short, polite follow-up to the original email below that received no reply.' : 'Write the outreach email.'}\n\n${JSON.stringify(payload, null, 2)}`;
  if (signature) text += '\n\nEnd the email with exactly the "required_signature" block.';
  if (instruction) text += `\n\nAdditional instruction from the candidate for this draft: ${instruction}`;
  return text;
}

const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{?[^}\n]{1,40}\}?\}|<(?:name|company|recruiter|your name)>/i;
const FABRICATED_CONTACT = /\b(referred (me|by)|recommended (me|that I)|suggested (I|that I) (reach|contact)|as (we|per our) (discussed|conversation)|our (recent )?(call|conversation|chat|meeting)|we (met|spoke)|great (talking|speaking|meeting))\b/i;
const MARKDOWN = /(\*\*|__|^#{1,6}\s|```|^\s*[-*]\s)/m;

/** Deterministic checks. `error` level blocks approval; `warning` does not. */
export function qualityCheck({ subject, body }, { recruiter, profile, kind, resumeText }) {
  const issues = [];
  const add = (level, message) => issues.push({ level, message });
  if (!subject?.trim()) add('error', 'Subject is empty.');
  if (!body?.trim()) add('error', 'Body is empty.');
  if (!subject || !body) return issues;

  if (PLACEHOLDER.test(subject) || PLACEHOLDER.test(body)) add('error', 'Contains a placeholder such as [Company] or {name}.');
  if (FABRICATED_CONTACT.test(body)) add('error', 'Implies a prior conversation or referral that may not exist.');
  if (MARKDOWN.test(body)) add('warning', 'Contains markdown or list formatting that will appear as raw characters.');
  if (subject.length > 90) add('warning', `Subject is long (${subject.length} characters).`);
  if (/!/.test(subject) || /^[^a-z]*$/.test(subject)) add('warning', 'Subject uses exclamation marks or all caps.');

  const words = body.split(/\s+/).filter(Boolean).length;
  const [min, max] = kind === 'follow_up' ? FOLLOW_UP_WORDS : [60, 300];
  if (words < min * 0.7) add('warning', `Body is very short (${words} words).`);
  if (words > max * 1.25) add('warning', `Body is long (${words} words).`);

  const first = firstName(recruiter?.name);
  const greeting = body.match(/^\s*(dear|hi|hello|hey)\s+([a-z][a-z.'-]*)/im);
  if (greeting) {
    const greeted = greeting[2].replace(/[.,]$/, '').toLowerCase();
    const generic = ['hiring', 'team', 'sir', 'madam', 'recruiter', 'there', 'all', 'mr', 'ms', 'mrs', 'dr'];
    if (!generic.includes(greeted) && (!first || greeted !== first.toLowerCase())) {
      add('error', `Greeting addresses "${greeting[2]}" but the contact's first name is ${first ? `"${first}"` : 'unknown'}.`);
    }
  }
  if (kind !== 'follow_up' && !/attach/i.test(body)) add('warning', 'Does not mention the attached resume.');
  const candidate = profile?.candidate_name?.split(' ')[0];
  if (candidate && !body.toLowerCase().includes(candidate.toLowerCase())) add('warning', 'Sign-off does not include your name.');
  if (recruiter?.company && kind !== 'follow_up') {
    const firstWord = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/)[0];
    const known = [recruiter.company, profile?.current_company, ...(profile?.experience || []).map((e) => e.company), ...(profile?.education || []).map((e) => e.institution)]
      .filter(Boolean)
      .map(firstWord);
    const resumeLower = (resumeText || '').toLowerCase();
    for (const m of body.matchAll(/\bat ([A-Z][\w&.-]+(?: [A-Z][\w&.-]+){0,2})\b/g)) {
      if (!known.includes(firstWord(m[1])) && !resumeLower.includes(m[1].toLowerCase())) {
        add('warning', `Mentions "${m[1]}", which is neither the recipient's company nor one of your employers.`);
      }
    }
  }
  return issues;
}

export function loadDraftContext(draftId) {
  const draft = q.get('SELECT * FROM email_drafts WHERE id = ?', draftId);
  if (!draft) throw httpError(404, 'Draft not found');
  const recruiter = q.get('SELECT * FROM recruiters WHERE id = ?', draft.recruiter_id);
  const campaign = q.get('SELECT * FROM campaigns WHERE id = ?', draft.campaign_id);
  const resumeId = draft.resume_id || campaign?.resume_id;
  const resume = resumeId ? q.get('SELECT * FROM resumes WHERE id = ?', resumeId) : null;
  return { draft, recruiter, campaign, resume };
}

function cleanBody(body) {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Generates (or regenerates) the content of a draft with Gemini. */
export async function generateDraft(draftId, { instruction } = {}) {
  const { draft, recruiter, campaign, resume } = loadDraftContext(draftId);
  if (['sending', 'sent', 'unknown'].includes(draft.status)) throw httpError(409, 'This email has already been sent or is being sent.');
  if (!resume) throw httpError(400, 'The campaign has no resume selected.');
  const { __edited, ...profile } = parseJson(resume.profile_json) || {};
  if (!Object.keys(profile).length) throw httpError(400, 'The selected resume has not been analyzed yet. Analyze it on the Resumes page first.');

  const previousStatus = draft.status;
  q.run("UPDATE email_drafts SET status = 'generating', generation_error = NULL, updated_at = ? WHERE id = ?", now(), draftId);

  try {
    let company = null;
    if (campaign.company_research && recruiter.company) {
      const domain = emailDomain(recruiter.email_normalized);
      company = await researchCompany(recruiter.company, { hint: isFreeDomain(recruiter.email_normalized) ? null : domain });
    }
    const parent = draft.parent_draft_id ? q.get('SELECT * FROM email_drafts WHERE id = ?', draft.parent_draft_id) : null;
    const followUp = draft.kind === 'follow_up' ? parent : null;
    if (draft.kind === 'follow_up' && !parent) throw new Error('Original email for this follow-up is missing.');

    const signature = getSetting('signature', '')?.trim() || null;
    const { data: result, model } = await generateJsonResult({
      system: systemPrompt({ style: campaign.style, followUp: !!followUp }),
      prompt: buildPrompt({ recruiter, campaign, profile, company, signature, followUp, instruction }),
      schema: DRAFT_SCHEMA,
      temperature: 0.7,
    });

    const subject = followUp ? `Re: ${parent.subject.replace(/^(re:\s*)+/i, '')}` : (result.subject || '').trim();
    const body = cleanBody(result.body || '');
    const quality = qualityCheck({ subject, body }, { recruiter, profile, kind: draft.kind, resumeText: resume.text_content });
    const personalization = {
      points: result.personalization_points || [],
      profileFacts: result.profile_facts_used || [],
      companyFacts: result.company_facts_used || [],
      company: company ? { summary: company.summary, facts: company.facts, sources: company.sources, error: company.error } : null,
      instruction: instruction || null,
    };

    tx(() => {
      const current = q.get('SELECT version FROM email_drafts WHERE id = ?', draftId);
      const version = current.version + 1;
      q.run(
        `UPDATE email_drafts SET subject = ?, body = ?, rationale = ?, personalization_json = ?, quality_json = ?, status = 'draft',
           version = ?, model = ?, resume_id = ?, attachment_name = ?, generation_error = NULL, updated_at = ? WHERE id = ?`,
        subject, body, result.rationale || '', personalization, quality, version, model, resume.id,
        draft.kind === 'follow_up' ? null : resume.original_filename, now(), draftId,
      );
      q.run(
        'INSERT INTO draft_revisions (draft_id, version, subject, body, to_email, resume_id, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        draftId, version, subject, body, draft.to_email, resume.id, previousStatus === 'queued' ? 'ai' : 'regenerate', instruction || null, now(),
      );
      revokeApprovals(draftId, 'regenerated');
      audit('draft', draftId, previousStatus === 'queued' ? 'generated' : 'regenerated', { version, model, instruction });
    });
  } catch (err) {
    q.run(
      'UPDATE email_drafts SET status = ?, generation_error = ?, updated_at = ? WHERE id = ?',
      previousStatus === 'generating' ? 'queued' : previousStatus,
      err.message,
      now(),
      draftId,
    );
    throw err;
  }
}
