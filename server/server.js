const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");

const { renderDocument } = require("./lib/render");
const {
  isValidTemplateName,
  listTemplates,
  getTemplateBuffer,
  saveTemplate,
  renameTemplate,
  deleteTemplate,
  reorderTemplates,
} = require("./lib/templates");
const { requireApiToken, requireAdmin } = require("./lib/auth");
const { createLogger } = require("./lib/log");

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === ".docx") {
      cb(null, true);
    } else {
      cb(new Error("Only .docx files are accepted"), false);
    }
  },
});

function createApp() {
  const app = express();

  app.use(
    cors({
      origin: (origin, cb) => cb(null, origin || "*"),
      credentials: true,
    })
  );
  app.use(express.json());

  app.get("/templates", requireApiToken, async (req, res) => {
    const log = createLogger("docx-server", { runId: req.headers["x-run-id"] || null });
    const start = Date.now();
    try {
      const templates = await listTemplates();
      log.info("templates.listed", { count: templates.length, durationMs: Date.now() - start });
      res.json(templates);
    } catch (err) {
      log.error("templates.error", { error: err.message });
      res.status(500).json({ error: "Error listing templates" });
    }
  });

  app.post("/generate_document", requireApiToken, async (req, res) => {
    const log = createLogger("docx-server", { runId: req.headers["x-run-id"] || null });
    const start = Date.now();
    const { template, data } = req.body || {};
    log.info("generate.start", {
      template,
      dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
    });

    if (!isValidTemplateName(template)) {
      log.warn("generate.invalid_template", { template });
      return res.status(400).json({ error: "Invalid template name" });
    }

    const buf = await getTemplateBuffer(template);
    if (!buf) {
      log.warn("generate.template_not_found", { template });
      return res.status(404).json({ error: "Template not found" });
    }

    try {
      const result = renderDocument(buf, data);
      log.info("generate.done", { template, bytes: result.length, durationMs: Date.now() - start });
      res.setHeader("Content-Disposition", "attachment; filename=output.docx");
      res.setHeader("Content-Type", DOCX_MIME);
      res.send(result);
    } catch (err) {
      log.error("generate.error", { template, error: err.message });
      res.status(500).json({ error: "Error generating document" });
    }
  });

  app.get("/admin", requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  });

  app.use(
    "/admin",
    requireAdmin,
    express.static(path.join(__dirname, "public"))
  );

  const adminRouter = express.Router();
  adminRouter.use(requireAdmin);

  adminRouter.get("/templates", async (req, res) => {
    try {
      const templates = await listTemplates();
      res.json(templates);
    } catch (err) {
      console.error("Error listing templates:", err);
      res.status(500).json({ error: "Error listing templates" });
    }
  });

  adminRouter.post(
    "/templates/upload",
    upload.single("file"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "No .docx file provided" });
      }

      const rawName = req.body.name || req.file.originalname.replace(/\.docx$/i, "");
      const name = rawName.trim();

      if (!isValidTemplateName(name)) {
        return res.status(400).json({ error: "Invalid template name" });
      }

      try {
        await saveTemplate(name, req.file.buffer);
        res.json({ name });
      } catch (err) {
        console.error("Error saving template:", err);
        res.status(500).json({ error: "Error saving template" });
      }
    }
  );

  adminRouter.post("/templates/rename", async (req, res) => {
    const { oldName, newName } = req.body || {};

    if (!isValidTemplateName(oldName) || !isValidTemplateName(newName)) {
      return res.status(400).json({ error: "Invalid template name" });
    }

    try {
      const ok = await renameTemplate(oldName, newName);
      if (!ok) return res.status(404).json({ error: "Template not found" });
      res.json({ newName });
    } catch (err) {
      console.error("Error renaming template:", err);
      res.status(500).json({ error: "Error renaming template" });
    }
  });

  adminRouter.post("/templates/reorder", async (req, res) => {
    const { order } = req.body || {};

    if (!Array.isArray(order) || !order.every(isValidTemplateName)) {
      return res.status(400).json({ error: "Invalid order array" });
    }

    try {
      await reorderTemplates(order);
      res.json({ ok: true });
    } catch (err) {
      console.error("Error reordering templates:", err);
      res.status(500).json({ error: "Error reordering templates" });
    }
  });

  adminRouter.delete("/templates/:name", async (req, res) => {
    const name = req.params.name;

    if (!isValidTemplateName(name)) {
      return res.status(400).json({ error: "Invalid template name" });
    }

    try {
      const ok = await deleteTemplate(name);
      if (!ok) return res.status(404).json({ error: "Template not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("Error deleting template:", err);
      res.status(500).json({ error: "Error deleting template" });
    }
  });

  app.use("/admin/api", adminRouter);

  return app;
}

if (require.main === module) {
  createApp().listen(DEFAULT_PORT, () => {
    console.log(`Server is running on http://localhost:${DEFAULT_PORT}`);
  });
}

module.exports = { DOCX_MIME, createApp };
