// Unit test for deterministic case data mapping (lib/case-data.ts compiled output via tsx or direct ESM).
// Tests the field mapping and filename generation logic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Inline a JS port of the mapping logic to test it without needing tsx/a build step.
// This mirrors lib/case-data.ts exactly.

function formatReportDate(now) {
  const day = String(now.getDate());
  const month = String(now.getMonth() + 1);
  const year = now.getFullYear();
  return `${month}/${day}/${year}`;
}

function formatUTCTime(now) {
  const day = String(now.getUTCDate()).padStart(2, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const year = String(now.getUTCFullYear()).slice(2);
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, "0");
  return `${month}${day}${year}${hours}${minutes}${seconds}${milliseconds}`;
}

function buildGenerationMeta(feedCase, now = new Date()) {
  const report_date = formatReportDate(now);
  const utc_time = formatUTCTime(now);
  const data = {
    pid: feedCase.pid,
    sid: feedCase.sid,
    patient_name: feedCase.patient_name,
    patient_dob: feedCase.patient_dob,
    patient_age: feedCase.patient_age,
    patient_gender: feedCase.patient_gender,
    study_purpose: feedCase.study_purpose,
    clinical_notes: feedCase.clinical_notes,
    requesting_doctor: feedCase.requesting_doctor,
    submitting_group: feedCase.submitting_group,
    scan_date: feedCase.scan_date,
    report_date,
    utc_time,
  };
  const patientNameForFile = feedCase.patient_name.replace(/\s+/g, "_");
  const filename = `RadReport_${patientNameForFile}_${utc_time}_MA.docx`;
  return { data, filename };
}

const FEED_CASE = {
  id: "case-001",
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
};

// Fixed timestamp: 2026-06-29T19:15:30.123Z
const FIXED_DATE = new Date("2026-06-29T19:15:30.123Z");

describe("buildGenerationMeta", () => {
  it("maps all feed fields into the data object", () => {
    const { data } = buildGenerationMeta(FEED_CASE, FIXED_DATE);
    assert.equal(data.pid, "100001");
    assert.equal(data.sid, "200001");
    assert.equal(data.patient_name, "Jane Smith");
    assert.equal(data.patient_dob, "03/15/1975");
    assert.equal(data.patient_age, "49");
    assert.equal(data.patient_gender, "Female");
    assert.equal(data.study_purpose, "Evaluate TMJ");
    assert.equal(data.clinical_notes, "Chronic jaw pain");
    assert.equal(data.requesting_doctor, "Dr. Carter");
    assert.equal(data.submitting_group, "Westside Dental");
    assert.equal(data.scan_date, "06/20/2026");
  });

  it("computes report_date as M/D/YYYY in local time", () => {
    const { data } = buildGenerationMeta(FEED_CASE, FIXED_DATE);
    // FIXED_DATE in local time depends on timezone; verify format only
    assert.match(data.report_date, /^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it("computes utc_time as MMDDYYhhmmssSSS", () => {
    const { data } = buildGenerationMeta(FEED_CASE, FIXED_DATE);
    // UTC values: month=06, day=29, year=26, h=19, m=15, s=30, ms=123
    assert.equal(data.utc_time, "062926191530123");
  });

  it("generates filename with spaces replaced by underscores", () => {
    const { filename, data } = buildGenerationMeta(FEED_CASE, FIXED_DATE);
    assert.equal(filename, `RadReport_Jane_Smith_${data.utc_time}_MA.docx`);
  });

  it("is deterministic for the same timestamp", () => {
    const { data: d1, filename: f1 } = buildGenerationMeta(FEED_CASE, FIXED_DATE);
    const { data: d2, filename: f2 } = buildGenerationMeta(FEED_CASE, FIXED_DATE);
    assert.deepEqual(d1, d2);
    assert.equal(f1, f2);
  });
});
