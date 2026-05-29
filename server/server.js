const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const DEFAULT_TEMPLATE_DIR = path.resolve(__dirname, "templates");
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function listTemplates(templateDir = DEFAULT_TEMPLATE_DIR) {
  return fs
    .readdirSync(templateDir)
    .filter((file) => path.extname(file) === ".docx")
    .map((file) => path.basename(file, ".docx"))
    .sort((a, b) => a.localeCompare(b));
}

function resolveTemplatePath(template, templateDir = DEFAULT_TEMPLATE_DIR) {
  if (
    typeof template !== "string" ||
    template.trim() === "" ||
    template !== template.trim() ||
    template.includes("/") ||
    template.includes("\\")
  ) {
    return null;
  }

  return path.resolve(templateDir, `${template}.docx`);
}

function renderDocument(templatePath, data) {
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render(data || {});

  return doc.getZip().generate({ type: "nodebuffer" });
}

function createTemplateListHandler(templateDir = DEFAULT_TEMPLATE_DIR) {
  return (req, res) => {
    try {
      res.json(listTemplates(templateDir));
    } catch (error) {
      console.error("Error reading templates directory:", error);
      res.status(500).json({ error: "Error reading templates directory" });
    }
  };
}

function createDocumentGenerationHandler(templateDir = DEFAULT_TEMPLATE_DIR) {
  return (req, res) => {
    const { template, data } = req.body || {};
    const templatePath = resolveTemplatePath(template, templateDir);

    if (!templatePath) {
      return res.status(400).json({ error: "Invalid template name" });
    }

    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: "Template not found" });
    }

    try {
      const buf = renderDocument(templatePath, data);

      res.setHeader("Content-Disposition", "attachment; filename=output.docx");
      res.setHeader("Content-Type", DOCX_MIME);
      res.send(buf);
    } catch (error) {
      console.error("Error generating document:", error);
      res.status(500).json({ error: "Error generating document" });
    }
  };
}

function createApp({ templateDir = DEFAULT_TEMPLATE_DIR } = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/templates", createTemplateListHandler(templateDir));
  app.post("/generate_document", createDocumentGenerationHandler(templateDir));

  return app;
}

if (require.main === module) {
  createApp().listen(DEFAULT_PORT, () => {
    console.log(`Server is running on http://localhost:${DEFAULT_PORT}`);
  });
}

module.exports = {
  DOCX_MIME,
  createApp,
  createDocumentGenerationHandler,
  createTemplateListHandler,
  listTemplates,
  renderDocument,
  resolveTemplatePath,
};
