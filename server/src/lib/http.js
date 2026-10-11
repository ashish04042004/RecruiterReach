export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const httpError = (status, message, details) => new HttpError(status, message, details);

export function toInt(value, fallback = null) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function requireId(value, label = 'id') {
  const n = toInt(value);
  if (!n || n < 1) throw httpError(400, `Invalid ${label}`);
  return n;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function listFromText(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/[\n,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}
