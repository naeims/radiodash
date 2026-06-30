// Integration test: generate_document tool produces a valid docx.
// Mocks the Express docx server and Vercel Blob; does not require live external services.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Minimal valid DOCX bytes (PK header for ZIP = 0x504B0304)
const FAKE_DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

// Set up env vars before any module is imported that reads them.
process.env.DOCX_URL = "http://localhost:0"; // overridden after server starts
process.env.API_TOKEN = "test-token";
process.env.BLOB_READ_WRITE_TOKEN = "mock-blob-token";

let mockExpressServer;
let mockBlobServer;
let capturedBlobBody = null;

async function startServer(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

describe("MCP generate_document tool logic", () => {
  before(async () => {
    // Minimal mock Express docx server
    mockExpressServer = await startServer((req, res) => {
      if (req.method === "GET" && req.url === "/templates") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(["CBCT-Report", "OPG-Report"]));
        return;
      }
      if (req.method === "POST" && req.url === "/generate_document") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          );
          res.end(FAKE_DOCX);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const expressPort = mockExpressServer.address().port;
    process.env.DOCX_URL = `http://127.0.0.1:${expressPort}`;

    // Minimal mock Blob server (simulates PUT that @vercel/blob would call)
    mockBlobServer = await startServer((req, res) => {
      if (req.method === "PUT" || req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          capturedBlobBody = Buffer.concat(chunks);
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              url: "https://blob.example.com/RadReport_test.docx",
              downloadUrl: "https://blob.example.com/RadReport_test.docx",
              pathname: "RadReport_test.docx",
              contentType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              contentDisposition: "attachment; filename=RadReport_test.docx",
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const blobPort = mockBlobServer.address().port;
    // Override the Blob base URL so @vercel/blob points at our mock
    process.env.BLOB_BASE_URL = `http://127.0.0.1:${blobPort}`;
  });

  after(() => {
    mockExpressServer?.close();
    mockBlobServer?.close();
  });

  it("fetches templates from Express docx server", async () => {
    const docxUrl = process.env.DOCX_URL;
    const token = process.env.API_TOKEN;

    const res = await fetch(`${docxUrl}/templates`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 200);
    const templates = await res.json();
    assert.ok(Array.isArray(templates), "templates must be an array");
    assert.ok(templates.length > 0, "templates must be non-empty");
    assert.ok(templates.every((t) => typeof t === "string"), "each template must be a string");
  });

  it("calls Express generate_document and receives docx bytes", async () => {
    const docxUrl = process.env.DOCX_URL;
    const token = process.env.API_TOKEN;

    const data = {
      pid: "100001",
      sid: "200001",
      patient_name: "Jane Smith",
      patient_dob: "03/15/1975",
      patient_age: "49",
      patient_gender: "Female",
      study_purpose: "Evaluate TMJ",
      clinical_notes: "Chronic jaw pain",
      requesting_doctor: "Dr. Carter",
      submitting_group: "Westside Dental",
      scan_date: "06/20/2026",
      report_date: "6/29/2026",
      utc_time: "062926191530000",
    };

    const res = await fetch(`${docxUrl}/generate_document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ template: "CBCT-Report", data }),
    });

    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());

    // DOCX is a ZIP file; first 4 bytes are the PK signature
    assert.equal(buf[0], 0x50, "byte 0 should be P (PK signature)");
    assert.equal(buf[1], 0x4b, "byte 1 should be K (PK signature)");
  });
});
