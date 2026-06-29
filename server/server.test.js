const { describe, it, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Mock @vercel/blob before requiring anything that uses it
const mockPut = mock.fn(async () => ({ url: "https://blob.example/fake" }));
const mockDel = mock.fn(async () => {});
const mockList = mock.fn(async () => ({ blobs: [] }));
const mockHead = mock.fn(async (key) => {
  throw Object.assign(new Error("Not Found"), { status: 404 });
});

require.cache[require.resolve("@vercel/blob")] = {
  id: require.resolve("@vercel/blob"),
  filename: require.resolve("@vercel/blob"),
  loaded: true,
  exports: {
    put: mockPut,
    del: mockDel,
    list: mockList,
    head: mockHead,
  },
};

// Mock lib/templates so API tests don't need a real Blob token
const mockTemplates = {
  isValidTemplateName: mock.fn((name) => {
    return (
      typeof name === "string" &&
      name.trim() !== "" &&
      name === name.trim() &&
      !name.includes("/") &&
      !name.includes("\\")
    );
  }),
  listTemplates: mock.fn(async () => ["Basic", "IAC"]),
  getTemplateBuffer: mock.fn(async (name) => {
    if (name === "Basic") return Buffer.from("fake-docx-content");
    return null;
  }),
  saveTemplate: mock.fn(async () => {}),
  renameTemplate: mock.fn(async (oldName, newName) => oldName === "Basic"),
  deleteTemplate: mock.fn(async (name) => name === "Basic"),
  reorderTemplates: mock.fn(async () => {}),
};

require.cache[require.resolve("./lib/templates")] = {
  id: require.resolve("./lib/templates"),
  filename: require.resolve("./lib/templates"),
  loaded: true,
  exports: mockTemplates,
};

// Mock lib/render to avoid actual docx processing in auth tests
const mockRender = {
  renderDocument: mock.fn((buf, data) => Buffer.from("rendered-docx")),
};

require.cache[require.resolve("./lib/render")] = {
  id: require.resolve("./lib/render"),
  filename: require.resolve("./lib/render"),
  loaded: true,
  exports: mockRender,
};

const supertest = require("supertest");
const { createApp } = require("./server");

const API_TOKEN = "test-token-abc";
const ADMIN_USER = "admin";
const ADMIN_PASSWORD = "password";

let app;
let originalEnv;

before(() => {
  originalEnv = { ...process.env };
  process.env.API_TOKEN = API_TOKEN;
  process.env.ADMIN_USER = ADMIN_USER;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  app = createApp();
});

after(() => {
  process.env = originalEnv;
});

describe("GET /templates", () => {
  it("returns 401 without token", async () => {
    const res = await supertest(app).get("/templates");
    assert.equal(res.status, 401);
  });

  it("returns 401 with wrong token", async () => {
    const res = await supertest(app)
      .get("/templates")
      .set("Authorization", "Bearer wrong-token");
    assert.equal(res.status, 401);
  });

  it("returns 200 with correct Bearer token", async () => {
    const res = await supertest(app)
      .get("/templates")
      .set("Authorization", `Bearer ${API_TOKEN}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ["Basic", "IAC"]);
  });

  it("returns 200 with X-API-Token header", async () => {
    const res = await supertest(app)
      .get("/templates")
      .set("X-API-Token", API_TOKEN);
    assert.equal(res.status, 200);
  });
});

describe("OPTIONS preflight", () => {
  it("passes without token", async () => {
    const res = await supertest(app)
      .options("/templates")
      .set("Origin", "https://example.com")
      .set("Access-Control-Request-Method", "GET");
    assert.notEqual(res.status, 401);
  });

  it("passes for generate_document without token", async () => {
    const res = await supertest(app)
      .options("/generate_document")
      .set("Origin", "https://portal.example.com")
      .set("Access-Control-Request-Method", "POST");
    assert.notEqual(res.status, 401);
  });
});

describe("POST /generate_document", () => {
  it("returns 401 without token", async () => {
    const res = await supertest(app)
      .post("/generate_document")
      .send({ template: "Basic", data: {} });
    assert.equal(res.status, 401);
  });

  it("returns 400 for invalid template name", async () => {
    const res = await supertest(app)
      .post("/generate_document")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ template: "../evil", data: {} });
    assert.equal(res.status, 400);
  });

  it("returns 400 for empty template name", async () => {
    const res = await supertest(app)
      .post("/generate_document")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ template: "", data: {} });
    assert.equal(res.status, 400);
  });

  it("returns 400 for template name with slash", async () => {
    const res = await supertest(app)
      .post("/generate_document")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ template: "foo/bar", data: {} });
    assert.equal(res.status, 400);
  });

  it("returns 404 for missing template", async () => {
    const res = await supertest(app)
      .post("/generate_document")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ template: "NonExistent", data: {} });
    assert.equal(res.status, 404);
  });

  it("returns 200 with docx for valid template", async () => {
    const res = await supertest(app)
      .post("/generate_document")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ template: "Basic", data: { name: "Test" } });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers["content-type"].split(";")[0],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });
});

describe("Admin routes", () => {
  const basicAuth = (user, pass) =>
    "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  it("returns 401 on /admin/api/templates without credentials", async () => {
    const res = await supertest(app).get("/admin/api/templates");
    assert.equal(res.status, 401);
  });

  it("returns 401 with wrong credentials", async () => {
    const res = await supertest(app)
      .get("/admin/api/templates")
      .set("Authorization", basicAuth("admin", "wrong"));
    assert.equal(res.status, 401);
  });

  it("returns 200 on /admin/api/templates with correct credentials", async () => {
    const res = await supertest(app)
      .get("/admin/api/templates")
      .set("Authorization", basicAuth(ADMIN_USER, ADMIN_PASSWORD));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ["Basic", "IAC"]);
  });

  it("rejects rename with invalid names", async () => {
    const res = await supertest(app)
      .post("/admin/api/templates/rename")
      .set("Authorization", basicAuth(ADMIN_USER, ADMIN_PASSWORD))
      .send({ oldName: "Basic", newName: "../hack" });
    assert.equal(res.status, 400);
  });

  it("returns 404 on rename of non-existent template", async () => {
    const res = await supertest(app)
      .post("/admin/api/templates/rename")
      .set("Authorization", basicAuth(ADMIN_USER, ADMIN_PASSWORD))
      .send({ oldName: "NonExistent", newName: "NewName" });
    assert.equal(res.status, 404);
  });

  it("deletes a template", async () => {
    const res = await supertest(app)
      .delete("/admin/api/templates/Basic")
      .set("Authorization", basicAuth(ADMIN_USER, ADMIN_PASSWORD));
    assert.equal(res.status, 200);
  });

  it("returns 404 on delete of non-existent template", async () => {
    const res = await supertest(app)
      .delete("/admin/api/templates/NonExistent")
      .set("Authorization", basicAuth(ADMIN_USER, ADMIN_PASSWORD));
    assert.equal(res.status, 404);
  });
});
