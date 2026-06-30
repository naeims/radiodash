import { test } from "node:test";
import assert from "node:assert/strict";

// Mirror of extractUrl in app/api/agent/run/route.ts. Kept in sync intentionally:
// the route file is TS and not importable here without a build step, and this
// parser is the exact logic that previously failed to capture the blob URL.
function extractUrl(output) {
  if (output == null) return null;
  if (typeof output === "string") {
    try {
      return extractUrl(JSON.parse(output));
    } catch {
      return null;
    }
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const u = extractUrl(item);
      if (u) return u;
    }
    return null;
  }
  if (typeof output === "object") {
    const o = output;
    if (typeof o.url === "string") return o.url;
    for (const key of ["text", "content", "value", "output"]) {
      if (key in o) {
        const u = extractUrl(o[key]);
        if (u) return u;
      }
    }
  }
  return null;
}

const URL = "https://store.public.blob.vercel-storage.com/RadReport_X.docx";
const payload = JSON.stringify({ url: URL, filename: "RadReport_X.docx" });

test("extractUrl handles the MCP tool-result shapes", () => {
  // Plain object
  assert.equal(extractUrl({ url: URL }), URL);
  // JSON string
  assert.equal(extractUrl(payload), URL);
  // Array of text content parts
  assert.equal(extractUrl([{ type: "text", text: payload }]), URL);
  // Object with content array (the shape that previously slipped through)
  assert.equal(extractUrl({ content: [{ type: "text", text: payload }] }), URL);
  // AI SDK json output wrapper
  assert.equal(extractUrl({ type: "json", value: { url: URL } }), URL);
  // Nested output
  assert.equal(extractUrl({ output: { content: [{ text: payload }] } }), URL);
});

test("extractUrl returns null when there is no url", () => {
  assert.equal(extractUrl(null), null);
  assert.equal(extractUrl("not json"), null);
  assert.equal(extractUrl({ content: [{ type: "text", text: "no url here" }] }), null);
  assert.equal(extractUrl([]), null);
});
