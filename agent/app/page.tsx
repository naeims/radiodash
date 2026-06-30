import { getDb } from "@/lib/db";
import { createLogger, errFields } from "@/lib/log";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

interface Report {
  case_id: string;
  patient_name: string;
  template: string | null;
  blob_url: string | null;
  filename: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

async function getReports(): Promise<Report[]> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT case_id, patient_name, template, blob_url, filename, status, error, created_at
      FROM reports
      ORDER BY created_at DESC
    `) as unknown as Report[];
    return rows;
  } catch (err) {
    createLogger("agent-dashboard").error("reports.query_failed", errFields(err));
    return [];
  }
}

function checkBasicAuth(authHeader: string | null): boolean {
  const uiPassword = process.env.UI_PASSWORD;
  if (!uiPassword) return true;

  if (!authHeader || !authHeader.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
  const [, password] = decoded.split(":");
  return password === uiPassword;
}

export default async function Home() {
  const headersList = await headers();
  const authHeader = headersList.get("authorization");

  if (!checkBasicAuth(authHeader)) {
    redirect("/api/auth-challenge");
  }

  const reports = await getReports();

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 900, margin: "40px auto", padding: "0 16px" }}>
      <h1>Radiology Reports</h1>
      {reports.length === 0 ? (
        <p>No reports generated yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Patient</th>
              <th style={thStyle}>Template</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Generated</th>
              <th style={thStyle}>Download</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.case_id}>
                <td style={tdStyle}>{r.patient_name}</td>
                <td style={tdStyle}>{r.template ?? "—"}</td>
                <td style={tdStyle}>{r.status}</td>
                <td style={tdStyle}>{new Date(r.created_at).toLocaleString()}</td>
                <td style={tdStyle}>
                  {r.blob_url ? (
                    <a href={r.blob_url} download={r.filename ?? undefined}>
                      {r.filename ?? "download"}
                    </a>
                  ) : r.error ? (
                    <span title={r.error}>Error</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid #ccc",
  padding: "8px",
};

const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "8px",
};
