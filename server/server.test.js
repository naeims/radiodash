const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createDocumentGenerationHandler,
  createTemplateListHandler,
  listTemplates,
  resolveTemplatePath,
} = require("./server");

function createTemplateDir() {
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "radiodash-"));

  fs.writeFileSync(path.join(templateDir, "Basic Template.docx"), "");
  fs.writeFileSync(path.join(templateDir, "Zaghi Template.docx"), "");
  fs.writeFileSync(path.join(templateDir, "README.txt"), "");

  return templateDir;
}

function createMockResponse() {
  return {
    body: undefined,
    headers: {},
    statusCode: 200,
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
  };
}

test("listTemplates returns sorted docx template names", () => {
  const templateDir = createTemplateDir();

  try {
    assert.deepEqual(listTemplates(templateDir), [
      "Basic Template",
      "Zaghi Template",
    ]);
  } finally {
    fs.rmSync(templateDir, { recursive: true, force: true });
  }
});

test("resolveTemplatePath rejects missing, blank, and path-like names", () => {
  const templateDir = path.join(os.tmpdir(), "radiodash-templates");

  assert.equal(resolveTemplatePath(undefined, templateDir), null);
  assert.equal(resolveTemplatePath("", templateDir), null);
  assert.equal(resolveTemplatePath(" Basic Template", templateDir), null);
  assert.equal(resolveTemplatePath("../package", templateDir), null);
  assert.equal(resolveTemplatePath("nested/template", templateDir), null);
  assert.equal(resolveTemplatePath("nested\\template", templateDir), null);
});

test("template list handler returns available template names", () => {
  const templateDir = createTemplateDir();

  try {
    const response = createMockResponse();

    createTemplateListHandler(templateDir)({}, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, ["Basic Template", "Zaghi Template"]);
  } finally {
    fs.rmSync(templateDir, { recursive: true, force: true });
  }
});

test("document generation handler validates template names before file access", () => {
  const templateDir = createTemplateDir();

  try {
    const response = createMockResponse();

    createDocumentGenerationHandler(templateDir)(
      { body: { template: "../package", data: {} } },
      response,
    );

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { error: "Invalid template name" });
  } finally {
    fs.rmSync(templateDir, { recursive: true, force: true });
  }
});

test("document generation handler reports missing templates", () => {
  const templateDir = createTemplateDir();

  try {
    const response = createMockResponse();

    createDocumentGenerationHandler(templateDir)(
      { body: { template: "Missing Template", data: {} } },
      response,
    );

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: "Template not found" });
  } finally {
    fs.rmSync(templateDir, { recursive: true, force: true });
  }
});
