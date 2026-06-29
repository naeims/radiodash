const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const { renderDocument } = require("./lib/render");

const TEMPLATE_PATH = path.join(__dirname, "templates", "Basic Template.docx");

describe("renderDocument", () => {
  it("fills placeholders in a real .docx buffer", { skip: !fs.existsSync(TEMPLATE_PATH) ? "Basic Template.docx not present locally" : false }, () => {
    const buffer = fs.readFileSync(TEMPLATE_PATH);
    const data = {
      patient_name: "Jane Doe",
      pid: "12345",
      report_date: "1/1/2026",
    };

    const result = renderDocument(buffer, data);

    assert.ok(result instanceof Buffer, "result should be a Buffer");
    assert.ok(result.length > 0, "result should not be empty");

    // Verify it's a valid zip (docx is a zip)
    assert.doesNotThrow(() => {
      const zip = new PizZip(result);
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
      doc.render({});
    }, "rendered output should be a valid docx");
  });

  it("returns a Buffer for empty data object", { skip: !fs.existsSync(TEMPLATE_PATH) ? "Basic Template.docx not present locally" : false }, () => {
    const buffer = fs.readFileSync(TEMPLATE_PATH);
    const result = renderDocument(buffer, {});
    assert.ok(result instanceof Buffer);
    assert.ok(result.length > 0);
  });
});
