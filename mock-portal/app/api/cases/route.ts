import { NextResponse } from "next/server";
import { head, getDownloadUrl } from "@vercel/blob";
import path from "path";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Prefer Blob-backed cases when BLOB_READ_WRITE_TOKEN is set and a blob exists.
  // Fall back to the committed cases.json for local development.
  if (process.env.BLOB_READ_WRITE_TOKEN && process.env.CASES_BLOB_URL) {
    try {
      const { url } = await head(process.env.CASES_BLOB_URL);
      const downloadUrl = getDownloadUrl(url);
      const res = await fetch(downloadUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
      const cases = await res.json();
      return NextResponse.json(cases);
    } catch (err) {
      console.error("Failed to read cases from Blob, falling back to local file:", err);
    }
  }

  const filePath = path.join(process.cwd(), "cases.json");
  const raw = await fs.readFile(filePath, "utf-8");
  const cases = JSON.parse(raw);
  return NextResponse.json(cases);
}
