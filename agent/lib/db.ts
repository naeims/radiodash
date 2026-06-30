import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

type Sql = NeonQueryFunction<false, false>;

export function getDb(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export async function ensureSchema(sql: Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS reports (
      case_id      TEXT PRIMARY KEY,
      patient_name TEXT NOT NULL,
      template     TEXT,
      blob_url     TEXT,
      filename     TEXT,
      status       TEXT NOT NULL DEFAULT 'done',
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

export async function getProcessedCaseIds(sql: Sql): Promise<Set<string>> {
  const rows = (await sql`SELECT case_id FROM reports WHERE status = 'done' AND blob_url IS NOT NULL`) as unknown as { case_id: string }[];
  return new Set(rows.map((r) => r.case_id));
}

export async function insertReport(
  sql: Sql,
  params: {
    case_id: string;
    patient_name: string;
    template: string | null;
    blob_url: string | null;
    filename: string | null;
    status: "done" | "error";
    error?: string | null;
  }
) {
  await sql`
    INSERT INTO reports (case_id, patient_name, template, blob_url, filename, status, error)
    VALUES (
      ${params.case_id},
      ${params.patient_name},
      ${params.template},
      ${params.blob_url},
      ${params.filename},
      ${params.status},
      ${params.error ?? null}
    )
    ON CONFLICT (case_id) DO UPDATE SET
      patient_name = EXCLUDED.patient_name,
      template     = EXCLUDED.template,
      blob_url     = EXCLUDED.blob_url,
      filename     = EXCLUDED.filename,
      status       = EXCLUDED.status,
      error        = EXCLUDED.error,
      created_at   = now()
  `;
}
