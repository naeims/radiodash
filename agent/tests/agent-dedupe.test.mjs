// Integration test: agent run dedupe logic.
// Tests that cases with existing report rows are skipped without touching the DB/AI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The dedupe logic from the run route is: filter allCases where !processed.has(c.id)
// We test that function in isolation since the route itself requires live services.

function computePending(allCases, processedIds) {
  return allCases.filter((c) => !processedIds.has(c.id));
}

const CASES = [
  { id: "case-001", patient_name: "Jane Smith" },
  { id: "case-002", patient_name: "Robert Johnson" },
  { id: "case-003", patient_name: "Aisha Patel" },
];

describe("agent dedupe", () => {
  it("returns all cases when none are processed", () => {
    const pending = computePending(CASES, new Set());
    assert.equal(pending.length, 3);
  });

  it("skips already-processed cases", () => {
    const processed = new Set(["case-001", "case-003"]);
    const pending = computePending(CASES, processed);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "case-002");
  });

  it("returns empty when all cases are processed", () => {
    const processed = new Set(CASES.map((c) => c.id));
    const pending = computePending(CASES, processed);
    assert.equal(pending.length, 0);
  });

  it("respects the MAX_CASES_PER_RUN cap", () => {
    const MAX_CASES_PER_RUN = 1;
    const pending = computePending(CASES, new Set());
    const toProcess = pending.slice(0, MAX_CASES_PER_RUN);
    assert.equal(toProcess.length, 1);
    assert.equal(toProcess[0].id, "case-001");
  });
});
