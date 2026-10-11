import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { CLIENT_DIST, CLIENT_URL, HOST, PORT, DATA_DIR } from './config.js';
import './db.js';
import { HttpError } from './lib/http.js';
import { recoverInterrupted } from './lib/sender.js';
import importsRouter from './routes/imports.js';
import recruitersRouter from './routes/recruiters.js';
import resumesRouter from './routes/resumes.js';
import campaignsRouter from './routes/campaigns.js';
import draftsRouter from './routes/drafts.js';
import systemRouter from './routes/system.js';

recoverInterrupted();

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: [CLIENT_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/imports', importsRouter);
app.use('/api/recruiters', recruitersRouter);
app.use('/api/resumes', resumesRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api', systemRouter);

app.use('/api', (req, res) => res.status(404).json({ error: `No API route for ${req.method} ${req.path}` }));

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  const status = err instanceof HttpError ? err.status : err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Unexpected error', details: err.details });
});

app.listen(PORT, HOST, () => {
  console.log(`RecruiterReach API on http://localhost:${PORT} (data: ${DATA_DIR})`);
  if (!process.env.GEMINI_API_KEY) console.log('  GEMINI_API_KEY not set: AI features are disabled until you add it to .env');
  if (!process.env.GOOGLE_CLIENT_ID) console.log('  GOOGLE_CLIENT_ID not set: Gmail sending is disabled until you add OAuth credentials to .env');
});
