# agent

Next.js project that holds the MCP server, agent loop, Postgres state, and download UI for the
agentic radiology-report pipeline.

## Architecture

```
local crontab (WSL) --POST /api/agent/run (Bearer CRON_SECRET)--> this project (Vercel)
                                                                    |
  /api/mcp/[transport]   mcp-handler tools:                        |
        list_templates -- fetch() --> Express docx server           |
        generate_document -- fetch() --> Express docx server        |
                          -- put()  --> Vercel Blob                 |
  /api/agent/run   AI SDK ToolLoopAgent via Vercel AI Gateway       |
        fetches cases from mock-portal                              |
        filters already-processed case IDs (Neon Postgres)          |
        runs agent per case, inserts report row                     |
  /  download UI (server component, lists reports table)            |
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Description |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Yes (local) | Vercel AI Gateway key (auto OIDC on Vercel) |
| `AGENT_MODEL` | No | Gateway model string, default `anthropic/claude-haiku-4-5` |
| `DOCX_URL` | Yes | Base URL of the deployed Express docx server |
| `API_TOKEN` | Yes | Bearer token for the Express docx server |
| `MOCK_URL` | Yes | Base URL of the mock-portal project |
| `NEXT_PUBLIC_BASE_URL` | Yes | Public URL of this project (used by the agent to call /api/mcp) |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob token for storing generated .docx files |
| `DATABASE_URL` | Yes | Neon Postgres connection string |
| `CRON_SECRET` | Yes | Secret that the local cron supplies as a Bearer token |
| `MCP_TOKEN` | No | Bearer token for /api/mcp; defaults to `API_TOKEN` if unset |
| `UI_PASSWORD` | No | Basic auth password for the download UI; leave empty to disable in dev |

## Local setup

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev
```

For a real run you need:
- A deployed Express docx server (`DOCX_URL` + `API_TOKEN`)
- A running mock-portal (`MOCK_URL`)
- A Neon Postgres database (`DATABASE_URL`) — the schema is created automatically on first run
- A Vercel Blob store (`BLOB_READ_WRITE_TOKEN`)
- A Vercel AI Gateway key (`AI_GATEWAY_API_KEY`)

Tests mock all external services and run without any of the above.

## Tests

```bash
npm test
```

Tests cover:
- `case-data.test.mjs` — deterministic field mapping and filename generation
- `agent-dedupe.test.mjs` — dedupe logic skips already-processed cases
- `mcp-generate-document.test.mjs` — MCP tool calls against mocked Express server

## Deploy (Vercel)

```bash
vercel --prod
```

Enable **Fluid compute** on this project in the Vercel dashboard (Project Settings > Functions)
to handle bursty AI/MCP traffic efficiently. Fluid compute provides up to 300 s execution time
per invocation, which accommodates the agent loop processing multiple cases.

## Local cron trigger (WSL)

Add to crontab (`crontab -e`) to fire every 10 minutes:

```
*/10 * * * * curl -s -X POST https://<your-agent>.vercel.app/api/agent/run -H "Authorization: Bearer <CRON_SECRET>"
```

Replace `<your-agent>` and `<CRON_SECRET>` with your actual values.

Alternatively, reuse the existing pm2 approach already used for the local docx server:
create a pm2 script that calls the curl command on an interval.

## Testing the full loop (deployed)

End to end: add a case to the feed, let the agent generate the report, download it from the UI.

1. **Add a case** — edit `mock-portal/cases.json` and append an object with a new unique `id`
   and the case fields (`pid`, `sid`, `patient_name`, `patient_dob`, `patient_age`,
   `patient_gender`, `study_purpose`, `clinical_notes`, `requesting_doctor`, `submitting_group`,
   `scan_date`).

2. **Publish the feed to Blob** (no redeploy needed):

   ```bash
   cd mock-portal
   npx vercel env pull .env.local --environment=production --yes
   node --env-file=.env.local scripts/push-cases.js
   ```

3. **Trigger the agent** (or wait for the local cron):

   ```bash
   curl -s -X POST https://<your-agent>.vercel.app/api/agent/run \
     -H "Authorization: Bearer <CRON_SECRET>"
   ```

   Expect `{"processed":1,...,"results":[{"case_id":"<id>","status":"done"}]}`.

4. **Download** — open `https://<your-agent>.vercel.app/` and click **Download** next to the
   new patient.

Notes:
- The feed is CDN-cached for up to ~5 min (`s-maxage=300`), so step 3 may not see a new case
  immediately after step 2.
- At most 3 cases are processed per trigger (`MAX_CASES_PER_RUN`); run step 3 again to drain a backlog.
- A `done` row only counts as processed once it has a stored `blob_url`. `status:"error"` means no
  document was produced (e.g. the model did not call `generate_document`); the case retries on the
  next run.

## MCP server

The `/api/mcp/[transport]` route exposes two tools usable by any MCP client (e.g. Claude Desktop):

- `list_templates` — returns available report template names from the docx server
- `generate_document(template, data)` — generates a populated .docx, uploads to Blob, returns `{ url, filename }`

Protect access with `MCP_TOKEN` (or `API_TOKEN`). Pass as `Authorization: Bearer <token>`.

## Swapping the model

Set `AGENT_MODEL` to any Vercel AI Gateway model string without changing code:

```
AGENT_MODEL=anthropic/claude-opus-4-5
AGENT_MODEL=openai/gpt-4o
AGENT_MODEL=google/gemini-2.0-flash
```

## Replacing the mock feed

When a real portal API is available, set `MOCK_URL` to its base URL and ensure it exposes
`GET /api/cases` returning the same case shape. No code changes are needed.
