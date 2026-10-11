import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..', '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
export const IMPORTS_DIR = path.join(DATA_DIR, 'imports');
export const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
export const DB_PATH = path.join(DATA_DIR, 'recruiterreach.db');
export const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');

export const PORT = Number(process.env.PORT || 3001);
export const HOST = process.env.HOST || '127.0.0.1';
export const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
export const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
export const GMAIL_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${SERVER_URL}/api/gmail/oauth/callback`;

for (const dir of [DATA_DIR, IMPORTS_DIR, RESUMES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
