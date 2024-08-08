const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const cors = require("cors");

const app = express();
const PORT = 5000;

app.use(cors());
app.use(bodyParser.json());

app.post("/generate_document", (req, res) => {
  console.log("request");
  const data = req.body;
  const content = fs.readFileSync(
    path.resolve(__dirname, "templates", "TMJ Template.docx"),
    "binary",
  );
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  doc.render(data);

  const buf = doc.getZip().generate({ type: "nodebuffer" });

  // Send the document as a response
  res.setHeader("Content-Disposition", "attachment; filename=output.docx");
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.send(buf);

  console.log("success");
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
