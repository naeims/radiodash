const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

function renderDocument(buffer, data) {
  const zip = new PizZip(buffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render(data || {});

  return doc.getZip().generate({ type: "nodebuffer" });
}

module.exports = { renderDocument };
