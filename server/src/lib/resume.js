import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { generateJson } from './gemini.js';

export const RESUME_MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function extractResumeText(buffer, ext) {
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return (result.text || '').replace(/\n{3,}/g, '\n\n').trim();
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || '').replace(/\n{3,}/g, '\n\n').trim();
  }
  throw new Error(`Unsupported resume type ${ext}`);
}

const str = { type: 'string' };
const strList = { type: 'array', items: { type: 'string' } };

export const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    candidate_name: str,
    email: str,
    phone: str,
    linkedin: str,
    portfolio: { type: 'string', description: 'GitHub or personal website, if present' },
    location: str,
    current_role: str,
    current_company: str,
    total_experience_years: { type: 'number', description: 'Total professional experience in years, 0 if a fresher' },
    headline: { type: 'string', description: 'One-line professional headline built only from resume facts' },
    summary: { type: 'string', description: '2-3 sentence factual summary' },
    technical_skills: strList,
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: str,
          company: str,
          start: str,
          end: str,
          highlights: strList,
        },
        required: ['title', 'company'],
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        properties: { degree: str, institution: str, year: str, details: str },
        required: ['degree', 'institution'],
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, description: str, technologies: strList },
        required: ['name'],
      },
    },
    achievements: strList,
    certifications: strList,
    target_roles: { ...strList, description: 'Roles this candidate is a natural fit for, inferred conservatively' },
    preferred_locations: { ...strList, description: 'Only if stated in the resume; otherwise empty' },
    value_proposition: {
      type: 'string',
      description: 'One concise sentence on what the candidate brings to an employer, grounded only in resume facts',
    },
  },
  required: ['candidate_name', 'technical_skills', 'experience', 'education', 'value_proposition'],
};

const SYSTEM = `You convert a resume into a structured candidate profile.
Rules:
- Use only information present in the resume. Never invent employers, titles, dates, metrics, skills or links.
- Copy contact details exactly as written. Leave a field empty ("" or []) when the resume does not contain it.
- Keep highlights short and factual, preserving any numbers exactly as written.
- target_roles may be inferred conservatively from the candidate's actual titles and skills.`;

export async function analyzeResume({ text, buffer, mimeType }) {
  const usable = text && text.replace(/\s/g, '').length > 200;
  if (usable) {
    return generateJson({ system: SYSTEM, prompt: `Resume text:\n"""\n${text.slice(0, 60000)}\n"""`, schema: PROFILE_SCHEMA, temperature: 0.1 });
  }
  return generateJson({
    system: SYSTEM,
    parts: [
      { inlineData: { mimeType, data: buffer.toString('base64') } },
      { text: 'Extract the structured profile from this resume document.' },
    ],
    schema: PROFILE_SCHEMA,
    temperature: 0.1,
  });
}
