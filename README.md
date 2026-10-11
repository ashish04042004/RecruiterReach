# RecruiterReach

A local-first, AI-assisted recruiter outreach manager for your own job search. Import a messy recruiter spreadsheet, turn your resume into a structured profile, let Gemini draft a personalized email for each recruiter, review and approve every message yourself, and send them one by one from your Gmail account while tracking replies, bounces and follow-ups.

It runs entirely on your machine. Your contacts, resumes and emails live in a local SQLite database, and API keys stay in a local `.env` file that never reaches the browser.

> **No email is ever sent without your explicit approval.** Approval is enforced by the backend, and editing an approved email invalidates the approval.

## Features

- **Excel import with review.** Handles workbooks with many sheets and inconsistent columns. Columns are mapped deterministically first; Gemini is only asked about ambiguous ones. Multiple contacts per row (e.g. "HR 1", "HR 2") become separate people, student/coordinator columns and roll-number emails are excluded, and you review every mapping and preview the result before importing.
- **Normalization and deduplication.** Names, phones, companies and emails are cleaned up and duplicates are merged across sheets. Every contact keeps its source sheet and row, and conflicting values are kept side by side for you to resolve.
- **Resume profiles.** Upload PDF or DOCX resumes, keep multiple versions, and have Gemini extract an editable structured profile. The original file is attached to emails.
- **Relevance scoring.** Contacts are ranked for each campaign by target companies, roles and locations, email quality and whether they are listed as HR/recruiting contacts, with the reasons shown.
- **AI drafting.** Gemini writes a concise subject and body per recruiter using schema-constrained JSON, plus a rationale. Optional company research uses Google Search grounding with cited sources.
- **Guardrails.** Drafts must not invent referrals, prior conversations, relationships, openings or skills. Automatic quality checks flag placeholders, wrong greeting names, implied referrals, unknown company mentions and missing attachments.
- **Review queue.** Edit, approve, regenerate with an instruction, skip or reject each draft, send a test copy to yourself, and see the full revision and approval history.
- **Safe sending through Gmail.** OAuth (no password stored), one email per recipient, a final confirmation where you type `SEND N`, a daily limit and a delay between sends, duplicate and previous-contact protection, opt-out and do-not-contact handling, and recovery from interrupted sessions without double-sending.
- **Tracking and follow-ups.** Syncs replies, bounces and opt-outs from Gmail, suggests follow-ups after a set number of days (each one approved individually) and stops when someone replies.
- **Analytics, audit trail and CSV export** for contacts, emails and every action taken.

## Tech stack

| Part | Technology |
| --- | --- |
| Frontend | React 19, React Router, Tailwind CSS 4, Vite |
| Backend | Node.js (Express 5), built-in `node:sqlite` |
| AI | Google Gemini via `@google/genai` |
| Email | Gmail API with OAuth 2.0 (`google-auth-library`, `nodemailer` for MIME) |
| Parsing | SheetJS (Excel), `pdf-parse` and `mammoth` (resumes) |

## Getting started

### Prerequisites

- Node.js **22.13 or newer** (uses the built-in SQLite module)
- A Gemini API key
- A Google Cloud OAuth client for Gmail (optional until you want to send)

### Install and run

```bash
git clone https://github.com/ashish04042004/RecruiterReach.git
cd RecruiterReach
npm install
cp .env.example .env   # on Windows: copy .env.example .env
# edit .env (see below)
npm run dev
```

Open <http://localhost:5173>. The API runs on <http://localhost:3001>.

To run a production build instead, use `npm run build` and then `npm start`; the server serves the built UI at <http://localhost:3001>.

### Configuration (`.env`)

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | For AI features | Key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | No | Default model (default `gemini-3.8-flash`); can be overridden on the Settings page |
| `GEMINI_FALLBACK_MODELS` | No | Comma-separated models tried when the main one is overloaded or retired |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | For sending | OAuth client for the Gmail API |
| `PORT`, `CLIENT_URL`, `DATA_DIR` | No | Server port, UI origin, and where data is stored (default `./data`) |

Restart `npm run dev` after editing `.env`.

### Setting up Gmail

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Gmail API**.
2. Open **Google Auth Platform**, create the consent screen with audience **External**, keep the publishing status on **Testing**, and add your own Gmail address under **Test users**.
3. Under **Clients**, create a **Web application** client with the authorized redirect URI `http://localhost:3001/api/gmail/oauth/callback`.
4. Put the client ID and secret into `.env`, restart, then click **Connect Gmail** on the Settings page.

Google shows an "unverified app" warning for your own testing app; choose **Continue**. In Testing mode Google expires the connection after 7 days, so reconnect from Settings when prompted.

## Typical workflow

1. **Settings:** connect Gmail, test Gemini, set your sender name and signature.
2. **Import:** upload your workbook, review sheets, contact groups and column mappings, preview, then import.
3. **Contacts:** resolve conflicts, verify email domains, mark do-not-contact.
4. **Resumes:** upload your resume and check the extracted profile.
5. **Campaigns:** set target roles, companies and style, then add the top-scored recipients.
6. **Review queue:** generate drafts, then edit and approve each one.
7. **Send:** confirm the final list on the campaign's Send tab; emails go out one by one.
8. **Replies & follow-ups:** sync Gmail, then create and approve follow-ups for contacts who haven't replied.

## Project structure

```
client/            React UI (Vite)
  src/pages/       Dashboard, Import, Contacts, Resumes, Campaigns, Review, Sending, Follow-ups, Analytics, Settings
server/
  src/db.js        SQLite schema and helpers
  src/lib/         Excel analysis, import/dedupe, Gemini, drafting, approvals, Gmail, sending, tracking, scoring
  src/routes/      REST API
data/              Local database, uploaded workbooks and resumes (git-ignored)
```

## Privacy and responsible use

- Everything is stored locally in `data/`; nothing is uploaded except the content sent to Gemini for parsing and drafting, and the emails you approve through Gmail.
- The app has **no login** and listens only on `localhost`. Don't expose it to the internet without adding authentication.
- Send individual, relevant messages, respect daily limits and honor opt-outs. You are responsible for complying with Gmail's policies and anti-spam laws.

## License

No license has been chosen yet; all rights reserved by the author.
