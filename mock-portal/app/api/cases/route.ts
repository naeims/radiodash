import { NextRequest, NextResponse } from "next/server";
import { head, getDownloadUrl } from "@vercel/blob";
import path from "path";
import fs from "fs/promises";
import { createLogger } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const log = createLogger("mock-portal-cases", {
    runId: req.headers.get("x-run-id") || null,
  });

  // Prefer Blob-backed cases when BLOB_READ_WRITE_TOKEN is set and a blob exists.
  // Fall back to the committed cases.json for local development.
  if (process.env.BLOB_READ_WRITE_TOKEN && process.env.CASES_BLOB_URL) {
    try {
      const { url } = await head(process.env.CASES_BLOB_URL);
      const downloadUrl = getDownloadUrl(url);
      const res = await fetch(downloadUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
      const cases = await res.json();
      log.info("cases.served", {
        source: "blob",
        count: Array.isArray(cases) ? cases.length : null,
        ids: Array.isArray(cases) ? cases.map((c) => c?.id) : null,
      });
      return NextResponse.json(cases);
    } catch (err) {
      log.error("cases.blob_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const filePath = path.join(process.cwd(), "cases.json");
  const raw = await fs.readFile(filePath, "utf-8");
  const cases = JSON.parse(raw);
  log.info("cases.served", {
    source: "local",
    count: Array.isArray(cases) ? cases.length : null,
    ids: Array.isArray(cases) ? cases.map((c) => c?.id) : null,
  });
  return NextResponse.json(cases);
}
