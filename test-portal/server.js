const fs = require("fs");
const http = require("http");
const path = require("path");

const DEFAULT_PORT = Number(process.env.PORT) || 5173;
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const FILES_DIR = path.resolve(__dirname, "files");
const CASE_PATH = "/patients/123456/radiology/789012";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSampleFiles() {
  if (!fs.existsSync(FILES_DIR)) {
    return [];
  }

  return fs
    .readdirSync(FILES_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith(".") &&
        !entry.name.endsWith(":Zone.Identifier"),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function renderDownloadRow(fileName) {
  const escapedFileName = escapeHtml(fileName);

  return `<div class="k-hbox mb-2 ng-star-inserted">
  <a kendotooltip class="k-column pl-2 f-size-14 flex-fill w-100 file-name-trunc" title="${escapedFileName}" data-title="">${escapedFileName}</a>
  <div class="k-d-flex k-flex-nowrap k-align-items-center k-justify-content-start" style="min-width: 55px;">
    <button kendobutton size="small" fillmode="flat" class="cursor-pointer text-fiord p-1 report-detail-download-btn k-button k-button-sm k-rounded-md k-button-flat-base k-button-flat ng-star-inserted" role="button" aria-disabled="false" dir="ltr">
      <span class="k-button-text"><span class="material-icons-outlined"> cloud_download </span></span>
    </button>
    <button kendobutton size="small" fillmode="flat" kendotooltip class="p-1 k-button k-button-sm k-rounded-md k-button-flat-base k-button-flat ng-star-inserted" title="Launch VoxView" role="button" aria-disabled="false" dir="ltr">
      <span class="k-button-text">V</span>
    </button>
  </div>
</div>`;
}

function renderPortalPage() {
  const files = getSampleFiles();
  const downloadRows = files.map(renderDownloadRow).join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>RadioDash Test Portal</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #f5f7fa;
        color: #25313b;
      }

      main {
        max-width: 960px;
        margin: 32px auto;
        padding: 0 20px;
      }

      .k-card {
        background: #fff;
        border: 1px solid #d9e1e8;
        border-radius: 6px;
        margin-bottom: 18px;
      }

      .k-card-body {
        padding: 18px;
      }

      .k-hbox {
        display: flex;
        align-items: center;
      }

      .mb-2 {
        margin-bottom: 8px;
      }

      .pl-2 {
        padding-left: 8px;
      }

      .f-size-14 {
        font-size: 14px;
      }

      .flex-fill {
        flex: 1 1 auto;
      }

      .w-100 {
        width: 100%;
      }

      .file-name-trunc {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .k-d-flex {
        display: flex;
      }

      .k-flex-nowrap {
        flex-wrap: nowrap;
      }

      .k-align-items-center {
        align-items: center;
      }

      .k-justify-content-start {
        justify-content: flex-start;
      }

      .report-detail-download-btn {
        border: none;
        background: transparent;
        color: #41596b;
        cursor: pointer;
        min-width: 32px;
        min-height: 32px;
      }

      .report-detail-download-btn[disabled] {
        cursor: default;
        opacity: 0.65;
      }

      .material-icons-outlined {
        font-family: Arial, sans-serif;
        font-size: 14px;
      }

      .detail-grid {
        display: grid;
        grid-template-columns: 160px 1fr;
        gap: 8px 14px;
      }

      .detail-label {
        color: #607080;
      }

      .detail-value,
      .k-link {
        color: #25313b;
      }

      .recent-files-list {
        padding: 10px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>RadioDash Test Portal</h1>
      <div class="patient-profile-image-name"><div class="f-size-24">Test Patient</div></div>

      <section class="k-card">
        <div class="k-card-body detail-grid">
          <div class="detail-label">DOB:</div><div class="detail-value">1/1/1970</div>
          <div class="detail-label">Age:</div><div class="detail-value">56</div>
          <div class="detail-label">Sex:</div><div class="detail-value">N/A</div>
          <div class="detail-label">Primary Dentist:</div><div class="k-link">Dr. Example</div>
          <div class="detail-label">Practice Name:</div><div class="k-link">Example Practice</div>
        </div>
      </section>

      <section class="k-card">
        <div class="k-card-body">
          <h2>Recent Files</h2>
          <div class="recent-files-list">
            ${downloadRows || "<p>No files found in test-portal/files.</p>"}
          </div>
        </div>
      </section>
    </main>

    <script>
      document.querySelectorAll(".report-detail-download-btn").forEach((button) => {
        button.addEventListener("click", () => {
          const row = button.closest(".k-hbox");
          const fileNameElement = row ? row.querySelector(".file-name-trunc") : null;
          const fileName = fileNameElement
            ? fileNameElement.getAttribute("title") || fileNameElement.textContent.trim()
            : "";
          const icon = button.querySelector(".material-icons-outlined");
          button.disabled = true;
          button.setAttribute("aria-disabled", "true");
          if (icon) {
            icon.textContent = " progress_activity ";
          }
          window.location.href = "/downloads/" + encodeURIComponent(fileName);
          window.setTimeout(() => {
            button.disabled = false;
            button.setAttribute("aria-disabled", "false");
            if (icon) {
              icon.textContent = " cloud_download ";
            }
          }, 2500);
        });
      });
    </script>
  </body>
</html>`;
}

function sendText(response, statusCode, body, contentType = "text/plain") {
  response.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendDownload(response, fileName) {
  const filePath = path.resolve(FILES_DIR, fileName);
  const relativePath = path.relative(FILES_DIR, filePath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile()
  ) {
    sendText(response, 404, "File not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, '\\"')}"`,
  });
  fs.createReadStream(filePath).pipe(response);
}

function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname === "/") {
    response.writeHead(302, { Location: CASE_PATH });
    response.end();
    return;
  }

  if (requestUrl.pathname === CASE_PATH) {
    sendText(response, 200, renderPortalPage(), "text/html");
    return;
  }

  if (requestUrl.pathname.startsWith("/downloads/")) {
    const fileName = decodeURIComponent(
      requestUrl.pathname.slice("/downloads/".length),
    );
    sendDownload(response, fileName);
    return;
  }

  sendText(response, 404, "Not found");
}

if (require.main === module) {
  http.createServer(handleRequest).listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(
      `Test portal running at http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    );
    console.log(
      `Case page: http://${DEFAULT_HOST}:${DEFAULT_PORT}${CASE_PATH}`,
    );
  });
}

module.exports = {
  CASE_PATH,
  FILES_DIR,
  getSampleFiles,
  handleRequest,
  renderPortalPage,
};
