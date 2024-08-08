const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());

app.get("/templates", (req, res) => {
  const templateDir = path.resolve(__dirname, "templates");
  fs.readdir(templateDir, (err, files) => {
    if (err) {
      res.status(500).send("Error reading templates directory");
    } else {
      const templates = files
        .filter((file) => path.extname(file) === ".docx")
        .map((file) => path.basename(file, ".docx"));
      res.json(templates);
    }
  });
});

app.post("/generate_document", (req, res) => {
  const { template, data } = req.body;

  const templatePath = path.resolve(__dirname, "templates", `${template}.docx`);
  if (!fs.existsSync(templatePath)) {
    return res.status(400).send("Template not found");
  }

  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render(data);

  const buf = doc.getZip().generate({ type: "nodebuffer" });

  res.setHeader("Content-Disposition", "attachment; filename=output.docx");
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.send(buf);
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
