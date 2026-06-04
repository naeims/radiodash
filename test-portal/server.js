const fs = require("fs");
const http = require("http");
const path = require("path");

const DEFAULT_PORT = Number(process.env.PORT) || 5173;
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const FILES_DIR = path.resolve(__dirname, "files");
const PATIENT_LIST_PATH = "/patients";
const TEST_PATIENTS = [
  {
    id: "100001",
    studyId: "900001",
    name: "Madhri Yeramalli",
    dob: "4/12/1981",
    age: "45",
    sex: "F",
    doctor: "Dr. Patel",
    practice: "Northside Dental",
    files: ["Madhri Yeramalli.zip"],
  },
  {
    id: "100002",
    studyId: "900002",
    name: "OBrien Conan",
    dob: "3/8/1969",
    age: "57",
    sex: "M",
    doctor: "Dr. Example",
    practice: "Example Practice",
    files: ["OBrien Conan - DICOMS.zip"],
  },
  {
    id: "100003",
    studyId: "900003",
    name: "F Thinker",
    dob: "9/17/1978",
    age: "47",
    sex: "N/A",
    doctor: "Dr. Ito",
    practice: "Central Imaging",
    files: ["F Thinker.zip"],
  },
  {
    id: "100004",
    studyId: "900004",
    name: "H Dog",
    dob: "6/2/1975",
    age: "51",
    sex: "N/A",
    doctor: "Dr. Chen",
    practice: "Two File Dental",
    files: ["H Dog 2.zip", "DICOMRM.zip"],
  },
  {
    id: "100005",
    studyId: "900005",
    name: "Rick Bleh",
    dob: "12/22/1962",
    age: "63",
    sex: "M",
    doctor: "Dr. Morgan",
    practice: "Westside Dental",
    files: ["Rick Bleh.zip"],
  },
  {
    id: "100006",
    studyId: "900006",
    name: "CT One",
    dob: "8/14/1990",
    age: "35",
    sex: "N/A",
    doctor: "Dr. Singh",
    practice: "CT Trial Clinic",
    files: ["CT1.zip"],
  },
  {
    id: "100007",
    studyId: "900007",
    name: "Timestamp Case",
    dob: "2/3/1988",
    age: "38",
    sex: "N/A",
    doctor: "Dr. Lee",
    practice: "Archive Dental",
    files: ["20260527_153144.zip"],
  },
  {
    id: "100008",
    studyId: "900008",
    name: "Zero Case",
    dob: "11/9/1971",
    age: "54",
    sex: "N/A",
    doctor: "Dr. Nguyen",
    practice: "Zero Study Group",
    files: ["000000000528_20260604122704.zip"],
  },
  {
    id: "100009",
    studyId: "900009",
    name: "McCarthy Sumo",
    dob: "5/27/1994",
    age: "32",
    sex: "N/A",
    doctor: "Dr. Alvarez",
    practice: "Invivo Direct",
    files: ["McCarthy1994_McCarthy_Sumo_20260527.inv"],
  },
];
const CASE_PATH = getPatientCasePath(TEST_PATIENTS[0]);

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

function getPatientCasePath(patient) {
  return `/patients/${encodeURIComponent(patient.id)}/radiology/${encodeURIComponent(
    patient.studyId,
  )}`;
}

function getPatientByPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (
    parts.length !== 4 ||
    parts[0] !== "patients" ||
    parts[2] !== "radiology"
  ) {
    return null;
  }

  return TEST_PATIENTS.find(
    (patient) => patient.id === parts[1] && patient.studyId === parts[3],
  );
}

function getPatientFiles(patient) {
  const availableFiles = new Set(getSampleFiles());

  return patient.files.filter((fileName) => availableFiles.has(fileName));
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

function renderPatientListPage() {
  const patientRows = TEST_PATIENTS.map((patient) => {
    const casePath = getPatientCasePath(patient);
    const files = getPatientFiles(patient);
    const escapedName = escapeHtml(patient.name);

    return `<tr>
      <td><a class="patient-link" href="${casePath}">${escapedName}</a></td>
      <td>${escapeHtml(patient.id)}</td>
      <td>${escapeHtml(patient.studyId)}</td>
      <td>${escapeHtml(files.join(", ") || "No configured files found")}</td>
      <td>${files.length}</td>
    </tr>`;
  }).join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>RadioDash Test Portal Patients</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #f5f7fa;
        color: #25313b;
      }

      main {
        max-width: 1080px;
        margin: 32px auto;
        padding: 0 20px;
      }

      .k-card {
        background: #fff;
        border: 1px solid #d9e1e8;
        border-radius: 6px;
      }

      .k-card-body {
        padding: 18px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        border-bottom: 1px solid #d9e1e8;
        font-size: 14px;
        padding: 10px 8px;
        text-align: left;
        vertical-align: top;
      }

      th {
        color: #607080;
        font-weight: 700;
      }

      tr:last-child td {
        border-bottom: none;
      }

      .patient-link {
        color: #1f5f8f;
        font-weight: 700;
        text-decoration: none;
      }

      .patient-link:hover {
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Patients</h1>
      <section class="k-card">
        <div class="k-card-body">
          <table>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Patient ID</th>
                <th>Study ID</th>
                <th>Test file</th>
                <th>Files</th>
              </tr>
            </thead>
            <tbody>
              ${patientRows}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderPortalPage(patient = TEST_PATIENTS[0]) {
  const files = getPatientFiles(patient);
  const downloadRows = files.map(renderDownloadRow).join("\n");
  const escapedName = escapeHtml(patient.name);

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

      .back-link {
        color: #1f5f8f;
        display: inline-block;
        font-size: 14px;
        font-weight: 700;
        margin-bottom: 12px;
        text-decoration: none;
      }

      .back-link:hover {
        text-decoration: underline;
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
      <a class="back-link" href="${PATIENT_LIST_PATH}">Patients</a>
      <h1>RadioDash Test Portal</h1>
      <div class="patient-profile-image-name"><div class="f-size-24">${escapedName}</div></div>

      <section class="k-card">
        <div class="k-card-body detail-grid">
          <div class="detail-label">DOB:</div><div class="detail-value">${escapeHtml(patient.dob)}</div>
          <div class="detail-label">Age:</div><div class="detail-value">${escapeHtml(patient.age)}</div>
          <div class="detail-label">Sex:</div><div class="detail-value">${escapeHtml(patient.sex)}</div>
          <div class="detail-label">Primary Dentist:</div><div class="k-link">${escapeHtml(patient.doctor)}</div>
          <div class="detail-label">Practice Name:</div><div class="k-link">${escapeHtml(patient.practice)}</div>
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
    sendText(response, 200, renderPatientListPage(), "text/html");
    return;
  }

  if (requestUrl.pathname === PATIENT_LIST_PATH) {
    sendText(response, 200, renderPatientListPage(), "text/html");
    return;
  }

  const patient = getPatientByPath(requestUrl.pathname);

  if (patient) {
    sendText(response, 200, renderPortalPage(patient), "text/html");
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
      `Patient list: http://${DEFAULT_HOST}:${DEFAULT_PORT}${PATIENT_LIST_PATH}`,
    );
    console.log(
      `Case page: http://${DEFAULT_HOST}:${DEFAULT_PORT}${CASE_PATH}`,
    );
  });
}

module.exports = {
  CASE_PATH,
  FILES_DIR,
  PATIENT_LIST_PATH,
  TEST_PATIENTS,
  getSampleFiles,
  handleRequest,
  renderPatientListPage,
  renderPortalPage,
};
