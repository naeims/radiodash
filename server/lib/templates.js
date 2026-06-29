const { put, del, list, head } = require("@vercel/blob");

const ORDER_KEY = "templates/_order.json";

function isValidTemplateName(name) {
  return (
    typeof name === "string" &&
    name.trim() !== "" &&
    name === name.trim() &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function blobKey(name) {
  return `templates/${name}.docx`;
}

async function readOrder() {
  try {
    const result = await head(ORDER_KEY);
    const res = await fetch(result.url);
    return await res.json();
  } catch {
    return [];
  }
}

async function writeOrder(names) {
  const buf = Buffer.from(JSON.stringify(names));
  await put(ORDER_KEY, buf, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

async function listTemplates() {
  const [order, { blobs }] = await Promise.all([
    readOrder(),
    list({ prefix: "templates/", limit: 1000 }),
  ]);

  const present = new Set(
    blobs
      .map((b) => b.pathname)
      .filter((p) => p.endsWith(".docx"))
      .map((p) => p.replace(/^templates\//, "").replace(/\.docx$/, ""))
  );

  const ordered = order.filter((n) => present.has(n));
  for (const n of present) {
    if (!ordered.includes(n)) {
      ordered.push(n);
    }
  }

  return ordered;
}

async function getTemplateBuffer(name) {
  try {
    const result = await head(blobKey(name));
    const res = await fetch(result.url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function saveTemplate(name, buffer) {
  await put(blobKey(name), buffer, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  const order = await readOrder();
  if (!order.includes(name)) {
    order.push(name);
    await writeOrder(order);
  }
}

async function renameTemplate(oldName, newName) {
  const buf = await getTemplateBuffer(oldName);
  if (!buf) return false;

  await put(blobKey(newName), buf, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  const oldBlob = await head(blobKey(oldName));
  await del(oldBlob.url);

  const order = await readOrder();
  const idx = order.indexOf(oldName);
  if (idx !== -1) {
    order[idx] = newName;
  } else {
    order.push(newName);
  }
  await writeOrder(order);
  return true;
}

async function deleteTemplate(name) {
  try {
    const result = await head(blobKey(name));
    await del(result.url);
  } catch {
    return false;
  }

  const order = await readOrder();
  const filtered = order.filter((n) => n !== name);
  await writeOrder(filtered);
  return true;
}

async function reorderTemplates(orderedNames) {
  await writeOrder(orderedNames);
}

module.exports = {
  isValidTemplateName,
  listTemplates,
  getTemplateBuffer,
  saveTemplate,
  renameTemplate,
  deleteTemplate,
  reorderTemplates,
};
