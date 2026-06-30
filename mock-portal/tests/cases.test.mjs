import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED_FIELDS = [
  "id",
  "pid",
  "sid",
  "patient_name",
  "patient_dob",
  "patient_age",
  "patient_gender",
  "study_purpose",
  "clinical_notes",
  "requesting_doctor",
  "submitting_group",
  "scan_date",
];

describe("cases.json shape", () => {
  it("is a non-empty array of case objects with all required fields", async () => {
    const raw = await fs.readFile(
      path.join(__dirname, "..", "cases.json"),
      "utf-8"
    );
    const cases = JSON.parse(raw);

    assert.ok(Array.isArray(cases), "cases.json must be an array");
    assert.ok(cases.length > 0, "cases.json must have at least one case");

    for (const c of cases) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(c, field),
          `Case ${c.id ?? "(unknown)"} is missing field: ${field}`
        );
        assert.ok(
          typeof c[field] === "string" && c[field].length > 0,
          `Case ${c.id ?? "(unknown)"} field "${field}" must be a non-empty string`
        );
      }
    }
  });

  it("has unique ids", async () => {
    const raw = await fs.readFile(
      path.join(__dirname, "..", "cases.json"),
      "utf-8"
    );
    const cases = JSON.parse(raw);
    const ids = cases.map((c) => c.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, "All case ids must be unique");
  });
});
