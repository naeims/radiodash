// Uploads local cases.json to Vercel Blob.
// Requires BLOB_READ_WRITE_TOKEN in the environment.
// After running, set CASES_BLOB_URL in your environment to the returned URL.

const { put } = require("@vercel/blob");
const fs = require("fs");
const path = require("path");

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN is not set");
    process.exit(1);
  }

  const filePath = path.join(__dirname, "..", "cases.json");
  const content = fs.readFileSync(filePath, "utf-8");

  const blob = await put("cases.json", content, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  console.log("Uploaded cases.json to Blob:");
  console.log("URL:", blob.url);
  console.log("Set CASES_BLOB_URL=" + blob.url + " in your environment.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
