# mock-portal

Simulates the future real portal API for the agentic radiology-report pipeline. Exposes
`GET /api/cases` returning an array of patient cases in the exact shape the agent expects.

## Fields per case

Each case object mirrors the fields the Chrome extension scrapes:

| Field | Description |
|---|---|
| `id` | Stable unique case identifier |
| `pid` | Patient ID (from URL path) |
| `sid` | Study ID (from URL path) |
| `patient_name` | Full name |
| `patient_dob` | Date of birth (MM/DD/YYYY) |
| `patient_age` | Age as string |
| `patient_gender` | Sex/gender |
| `study_purpose` | Reason for the scan |
| `clinical_notes` | Doctor's notes |
| `requesting_doctor` | Primary dentist |
| `submitting_group` | Practice name |
| `scan_date` | Date of scan (MM/DD/YYYY) |

`report_date` and `utc_time` are computed at generation time and are not stored here.

## Environment variables

See `.env.example`. For local development no env vars are required — `GET /api/cases` reads
`cases.json` from disk.

| Variable | Required | Description |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob token; only needed when using Blob-backed feed |
| `CASES_BLOB_URL` | No | Blob URL of the uploaded `cases.json`; only needed with Blob |

## Editing the feed

### Local / committed fallback (no Blob needed)

Edit `cases.json` directly. Every deploy picks up the latest file.

### Blob-backed (edits without redeploy)

1. Set `BLOB_READ_WRITE_TOKEN` in your environment.
2. Edit `cases.json`.
3. Run `npm run push-cases` — this uploads the file to Blob and prints the URL.
4. Set `CASES_BLOB_URL=<printed URL>` in your Vercel project environment variables.

The `GET /api/cases` handler tries Blob first and falls back to the committed file if Blob
is not configured.

## Setup

```bash
npm install
npm run dev       # starts on http://localhost:3000
```

## Tests

```bash
npm test
```

Tests verify `cases.json` shape: all required fields present, non-empty strings, unique IDs.

## Deploy (Vercel)

```bash
vercel --prod
```

After deploying, copy the project URL and set it as `MOCK_URL` in the agent project.
