import { GoogleGenAI } from '@google/genai';
import { getSetting } from '../db.js';
import { httpError, sleep } from './http.js';

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-3.5-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = 90_000;
const COOLDOWN_MS = 5 * 60_000;
const cooldownUntil = new Map();

let client = null;

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function geminiModel() {
  return getSetting('gemini_model') || DEFAULT_MODEL;
}

function ai() {
  if (!geminiConfigured()) {
    throw httpError(400, 'GEMINI_API_KEY is not set. Add it to the .env file in the project root and restart the server.');
  }
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

function errorStatus(err) {
  return err?.status ?? err?.code ?? err?.response?.status;
}

function isTimeout(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' || /aborted|timed? ?out/i.test(err?.message || '');
}

function isRetryable(err) {
  const status = errorStatus(err);
  return isTimeout(err) || status === 429 || status === 500 || status === 503 || /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(err?.message || '');
}

function isModelUnavailable(err) {
  return errorStatus(err) === 404 || /no longer available|not found for API version|is not supported/i.test(err?.message || '');
}

/**
 * Runs a request against the configured model, falling back through GEMINI_FALLBACK_MODELS when Google reports
 * a model as busy, retired or unresponsive. Failing models are skipped for a few minutes. Returns the response
 * and the model that answered.
 */
async function withFallback(request) {
  const all = [...new Set([geminiModel(), ...FALLBACK_MODELS])];
  const ready = all.filter((m) => !(cooldownUntil.get(m) > Date.now()));
  const models = ready.length ? ready : all;
  let lastError;
  for (const model of models) {
    try {
      const response = await request(model, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      cooldownUntil.delete(model);
      return { response, model };
    } catch (err) {
      lastError = err;
      if (!isModelUnavailable(err) && !isRetryable(err)) throw err;
      cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
      console.warn(`Gemini model ${model} unavailable (${isTimeout(err) ? 'timed out' : err?.message?.slice(0, 120)}); trying next model`);
    }
  }
  if (isTimeout(lastError)) throw httpError(504, 'Gemini did not respond in time. Google may be overloaded; try again in a few minutes.');
  throw lastError;
}

function parseJsonText(text) {
  if (!text) throw new Error('Gemini returned an empty response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('Gemini response was not valid JSON');
  }
}

/** Calls Gemini with a JSON schema. Returns the parsed object and the model that produced it. */
export async function generateJsonResult({ system, prompt, parts, schema, temperature = 0.4 }) {
  const { response, model } = await withFallback((model, abortSignal) =>
    ai().models.generateContent({
      model,
      contents: parts ? [{ role: 'user', parts }] : prompt,
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        temperature,
        abortSignal,
      },
    }),
  );
  return { data: parseJsonText(response.text), model };
}

export async function generateJson(options) {
  return (await generateJsonResult(options)).data;
}

/** Grounded research with Google Search. Returns parsed JSON plus the web sources Gemini cited. */
export async function generateGroundedJson({ system, prompt, temperature = 0.2 }) {
  const { response } = await withFallback((model, abortSignal) =>
    ai().models.generateContent({
      model,
      contents: prompt,
      config: { systemInstruction: system, tools: [{ googleSearch: {} }], temperature, abortSignal },
    }),
  );
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((c) => c.web)
    .filter((w) => w?.uri)
    .map((w) => ({ title: w.title || w.uri, uri: w.uri }));
  return { data: parseJsonText(response.text), sources };
}

export async function listModels() {
  const pager = await ai().models.list({ config: { pageSize: 100 } });
  const names = [];
  for await (const m of pager) {
    if (m.supportedActions?.includes('generateContent') ?? true) names.push(m.name?.replace(/^models\//, ''));
  }
  return names.filter((n) => n && /gemini/i.test(n)).sort();
}
