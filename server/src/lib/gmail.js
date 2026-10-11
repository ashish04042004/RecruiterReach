import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import { GMAIL_REDIRECT_URI } from '../config.js';
import { getSetting, setSetting, audit } from '../db.js';
import { httpError } from './http.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function gmailConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function gmailAccount() {
  const account = getSetting('gmail_account');
  return account && getSetting('gmail_tokens') ? account : null;
}

function client() {
  if (!gmailConfigured()) {
    throw httpError(400, 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env.');
  }
  const c = new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: GMAIL_REDIRECT_URI,
  });
  const tokens = getSetting('gmail_tokens');
  if (tokens) c.setCredentials(tokens);
  c.on('tokens', (fresh) => setSetting('gmail_tokens', { ...getSetting('gmail_tokens', {}), ...fresh }));
  return c;
}

const pendingStates = new Map();

export function authUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  return client().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state, include_granted_scopes: true });
}

export async function handleOAuthCallback(code, state) {
  const issued = pendingStates.get(state);
  pendingStates.delete(state);
  if (!issued || Date.now() - issued > 15 * 60 * 1000) throw httpError(400, 'OAuth state is invalid or expired. Start the connection again.');
  const c = client();
  const { tokens } = await c.getToken(code);
  setSetting('gmail_tokens', tokens);
  const profile = await api('GET', '/profile');
  setSetting('gmail_account', { email: profile.emailAddress, connectedAt: new Date().toISOString() });
  audit('gmail', null, 'connected', { email: profile.emailAddress });
  return profile.emailAddress;
}

export async function disconnect() {
  const tokens = getSetting('gmail_tokens');
  if (tokens?.refresh_token || tokens?.access_token) {
    try {
      await client().revokeToken(tokens.refresh_token || tokens.access_token);
    } catch {
      // Token may already be invalid; local removal is what matters.
    }
  }
  const account = getSetting('gmail_account');
  setSetting('gmail_tokens', null);
  setSetting('gmail_account', null);
  audit('gmail', null, 'disconnected', { email: account?.email });
}

async function api(method, path, data, params) {
  if (!getSetting('gmail_tokens')) throw httpError(400, 'Gmail is not connected. Connect it on the Settings page.');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, String(v));
  }
  const url = `${API}${path}${search.size ? `?${search}` : ''}`;
  try {
    const res = await client().request({ url, method, data });
    return res.data;
  } catch (err) {
    const status = err.response?.status ?? err.status;
    const message = err.response?.data?.error?.message || err.message;
    const wrapped = new Error(`Gmail API error${status ? ` ${status}` : ''}: ${message}`);
    wrapped.status = status;
    wrapped.providerResponse = err.response?.data;
    if (status === 401 || /invalid_grant/i.test(message)) wrapped.authError = true;
    throw wrapped;
  }
}

export function newMessageId() {
  return `<rr.${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@recruiterreach.local>`;
}

/** Builds an RFC 822 message with nodemailer (no SMTP involved) and returns it as base64url. */
export async function buildRawMessage({ from, to, subject, text, messageId, attachments = [], inReplyTo, references }) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await transport.sendMail({
    from,
    to,
    subject,
    text,
    messageId,
    inReplyTo,
    references,
    attachments,
  });
  return info.message.toString('base64url');
}

export async function sendRawMessage(raw, threadId) {
  return api('POST', '/messages/send', threadId ? { raw, threadId } : { raw });
}

export async function searchMessages(query, maxResults = 10) {
  const data = await api('GET', '/messages', null, { q: query, maxResults });
  return data.messages || [];
}

export async function getMessage(id) {
  return api('GET', `/messages/${id}`, null, {
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID', 'X-Failed-Recipients'],
  });
}

export async function getThread(id) {
  return api('GET', `/threads/${id}`, null, { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'] });
}

export function header(message, name) {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}
