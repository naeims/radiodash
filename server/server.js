const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const DEFAULT_TEMPLATE_DIR = path.resolve(__dirname, "templates");
const DA_STATE_DIR =
  process.env.DA_STATE_DIR ||
  path.join(os.tmpdir(), "radiodash-download-agent-state");
const DA_TEMP_DIR = process.env.DA_TEMP_DIR || null;
const OLLAMA_COMPLETIONS_URL =
  process.env.OLLAMA_COMPLETIONS_URL || "http://localhost:11434/v1/completions";
const OLLAMA_MODEL = "llama3.2";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DA_STATUS = Object.freeze({
  NOT_DOWNLOADED: "not_downloaded",
  PREPARING: "preparing",
  READY: "ready",
  FAILED: "failed",
});
const activeDownloadAgentJobs = new Map();

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

function nowIso() {
  return new Date().toISOString();
}

function hashKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeSegment(value, fallback = "item") {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return cleaned || fallback;
}

function safeFileName(fileName, fallback = "download") {
  const baseName = path.basename(String(fileName || fallback));
  const cleaned = baseName.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();

  return cleaned || fallback;
}

function isWsl() {
  return (
    process.platform === "linux" &&
    fs.existsSync("/proc/version") &&
    fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft")
  );
}

function windowsPathToWslPath(filePath) {
  const match = String(filePath).match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!match) {
    return filePath;
  }

  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");

  return `/mnt/${drive}/${rest}`;
}

function wslPathToWindowsPath(filePath) {
  const match = String(filePath).match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!match) {
    return filePath;
  }

  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

function normalizeDownloadedPath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return null;
  }

  if (isWsl()) {
    return windowsPathToWslPath(filePath.trim());
  }

  return path.normalize(filePath.trim());
}

function getWindowsUserTempFromWslPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/^\/mnt\/([a-z])\/Users\/([^/]+)(?:\/|$)/i);

  if (!match) {
    return null;
  }

  return `/mnt/${match[1].toLowerCase()}/Users/${match[2]}/AppData/Local/Temp`;
}

function getManagedTempRoot(sourceFilePath = "") {
  if (DA_TEMP_DIR) {
    return DA_TEMP_DIR;
  }

  if (isWsl()) {
    const windowsTemp = getWindowsUserTempFromWslPath(sourceFilePath);

    if (windowsTemp) {
      return path.join(windowsTemp, "radiodash-download-agent");
    }
  }

  return path.join(os.tmpdir(), "radiodash-download-agent");
}

function getCaseStatePath(caseKey) {
  return path.join(
    DA_STATE_DIR,
    "cases",
    `${safeSegment(caseKey, "case")}-${hashKey(caseKey).slice(0, 12)}`,
    "state.json",
  );
}

function readCaseState(caseKey) {
  const statePath = getCaseStatePath(caseKey);

  if (!fs.existsSync(statePath)) {
    return {
      caseKey,
      files: {},
    };
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function writeCaseState(state) {
  const statePath = getCaseStatePath(state.caseKey);

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  return state;
}

function validateCaseAndFile(req, res) {
  const { caseKey, fileId, fileName, downloadUrl } = req.body || {};

  if (
    typeof caseKey !== "string" ||
    caseKey.trim() === "" ||
    typeof fileId !== "string" ||
    fileId.trim() === ""
  ) {
    res.status(400).json({ error: "caseKey and fileId are required" });
    return null;
  }

  return {
    caseKey: caseKey.trim(),
    fileId: fileId.trim(),
    fileName:
      typeof fileName === "string" && fileName.trim() !== ""
        ? fileName.trim()
        : "download",
    downloadUrl:
      typeof downloadUrl === "string" && downloadUrl.trim() !== ""
        ? downloadUrl.trim()
        : "",
  };
}

function getOrCreateFileState(state, file) {
  state.files[file.fileId] = {
    fileId: file.fileId,
    fileName: file.fileName,
    downloadUrl: file.downloadUrl,
    status: DA_STATUS.NOT_DOWNLOADED,
    phase: "downloading",
    updatedAt: nowIso(),
    ...state.files[file.fileId],
  };

  state.files[file.fileId].fileName = file.fileName;
  state.files[file.fileId].downloadUrl = file.downloadUrl;

  return state.files[file.fileId];
}

function resetFileStateToNotDownloaded(fileState) {
  fileState.status = DA_STATUS.NOT_DOWNLOADED;
  fileState.phase = null;
  fileState.error = null;
  fileState.sourceFilePath = null;
  fileState.launchFilePath = null;
  fileState.launchFileUrl = null;
  fileState.managedFilePath = null;
  fileState.updatedAt = nowIso();
}

function pathExists(filePath) {
  return (
    typeof filePath === "string" && filePath !== "" && fs.existsSync(filePath)
  );
}

function hasStalePreparedDiskState(fileState) {
  const diskPaths = [
    fileState.launchFilePath,
    fileState.managedFilePath,
  ].filter((filePath) => typeof filePath === "string" && filePath !== "");

  if (fileState.status === DA_STATUS.READY) {
    return !pathExists(fileState.launchFilePath);
  }

  if (fileState.status !== DA_STATUS.FAILED) {
    return false;
  }

  return diskPaths.some((filePath) => !fs.existsSync(filePath));
}

function refreshCaseStateFromDisk(state) {
  let changed = false;

  Object.values(state.files).forEach((fileState) => {
    if (hasStalePreparedDiskState(fileState)) {
      console.log("[DA] Prepared disk state missing; resetting to Prepare", {
        fileId: fileState.fileId,
        launchFilePath: fileState.launchFilePath,
        managedFilePath: fileState.managedFilePath,
        status: fileState.status,
      });
      resetFileStateToNotDownloaded(fileState);
      changed = true;
    }
  });

  if (changed) {
    writeCaseState(state);
  }

  return state;
}

function stateForResponse(state) {
  return {
    caseKey: state.caseKey,
    files: Object.fromEntries(
      Object.entries(state.files).map(([fileId, fileState]) => [
        fileId,
        {
          fileId,
          fileName: fileState.fileName,
          downloadUrl: fileState.downloadUrl,
          status: fileState.status,
          phase: fileState.phase || null,
          error: fileState.error || null,
          launchFileUrl: fileState.launchFileUrl || null,
          updatedAt: fileState.updatedAt || null,
        },
      ]),
    ),
  };
}

function pathToFileUrl(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  const wslMatch = normalized.match(/^\/mnt\/([a-z])\/(.*)$/i);
  const winMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);

  if (wslMatch) {
    return `file:///${wslMatch[1].toUpperCase()}:/${wslMatch[2]
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  if (winMatch) {
    return `file:///${winMatch[1].toUpperCase()}:/${winMatch[2]
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }

  return `file://${normalized
    .split("/")
    .map((part, index) => (index === 0 ? "" : encodeURIComponent(part)))
    .join("/")}`;
}

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function openFileWithOs(filePath) {
  if (
    !filePath ||
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile()
  ) {
    throw new Error("Prepared launch file is missing");
  }

  console.log("[DA] Opening launch file with OS", { filePath });

  if (isWsl()) {
    const windowsPath = wslPathToWindowsPath(filePath);
    await spawnDetached("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Start-Process -FilePath ${quotePowerShellSingle(windowsPath)}`,
    ]);
    return;
  }

  if (process.platform === "win32") {
    await spawnDetached("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Start-Process -FilePath ${quotePowerShellSingle(filePath)}`,
    ]);
    return;
  }

  if (process.platform === "darwin") {
    await spawnDetached("open", [filePath]);
    return;
  }

  await spawnDetached("xdg-open", [filePath]);
}

function assertInside(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path outside extraction directory: ${targetPath}`);
  }
}

function waitForNextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function moveSourceToManaged(sourceFilePath, destinationDir, fileName) {
  const safeName = safeFileName(fileName, path.basename(sourceFilePath));
  const destinationPath = path.join(destinationDir, safeName);

  await fs.promises.mkdir(destinationDir, { recursive: true });

  if (path.resolve(sourceFilePath) === path.resolve(destinationPath)) {
    return destinationPath;
  }

  try {
    await fs.promises.rename(sourceFilePath, destinationPath);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }

    console.log("[DA] Rename crossed filesystems; falling back to copy+unlink", {
      sourceFilePath,
      destinationPath,
    });
    await fs.promises.copyFile(sourceFilePath, destinationPath);
    await fs.promises.unlink(sourceFilePath);
  }

  return destinationPath;
}

async function extractZipSafely(zipPath, destinationDir) {
  const zip = new AdmZip(zipPath);

  await fs.promises.mkdir(destinationDir, { recursive: true });

  for (const [index, entry] of zip.getEntries().entries()) {
    const entryName = entry.entryName.replace(/\\/g, "/");
    const destinationPath = path.resolve(destinationDir, entryName);

    assertInside(destinationDir, destinationPath);

    if (entry.isDirectory) {
      await fs.promises.mkdir(destinationPath, { recursive: true });
    } else {
      await fs.promises.mkdir(path.dirname(destinationPath), {
        recursive: true,
      });
      await fs.promises.writeFile(destinationPath, entry.getData());
    }

    if (index > 0 && index % 10 === 0) {
      await waitForNextTick();
    }
  }
}

async function buildAbridgedTree(rootDir) {
  const lines = ["."];
  const maxFilesPerDirectory = 10;

  async function walk(dir, prefix) {
    const entries = (
      await fs.promises.readdir(dir, { withFileTypes: true })
    )
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
    const dirs = entries.filter((entry) => entry.isDirectory());
    const files = entries.filter((entry) => entry.isFile());

    for (const entry of dirs) {
      lines.push(`${prefix}${entry.name}/`);
      await walk(path.join(dir, entry.name), `${prefix}  `);
    }

    files.slice(0, maxFilesPerDirectory).forEach((entry) => {
      lines.push(`${prefix}${entry.name}`);
    });

    if (files.length > maxFilesPerDirectory) {
      lines.push(
        `${prefix}... and ${files.length - maxFilesPerDirectory} more files`,
      );
    }

    await waitForNextTick();
  }

  await walk(rootDir, "  ");

  return lines.join("\n");
}

function parseStrictJsonObject(value) {
  const text = String(value || "").trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error("LLM response did not contain a JSON object");
  }

  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

async function chooseLaunchFileWithOllama(extractDir) {
  const tree = await buildAbridgedTree(extractDir);
  const prompt = `You select the launch file for Invivo dental imaging cases.

Return only strict JSON in this exact shape:
{"path":"relative/path/to/launch-file"}

Choose the single most likely file the radiologist should open. The path must be relative to the root shown below. Do not include markdown or explanations.
You must correctly handle directory structures that have spaces in their names and always generate a valid path.
Take extra care not to drop any space characters from the directory structure path names. For example, if a directory name is "A. BC 2", make sure your response uses that string exactly, and NOT "A.BC 2" where the space after the period is dropped erroneously.

Directory tree:
${tree}`;
  const ollamaRequest = {
    model: OLLAMA_MODEL,
    prompt,
    temperature: 0,
    max_tokens: 200,
    stream: false,
  };

  console.log("[DA][Ollama] Request", {
    url: OLLAMA_COMPLETIONS_URL,
    model: OLLAMA_MODEL,
    extractDir,
  });
  console.log("[DA][Ollama] Prompt\n" + prompt);
  const response = await fetch(OLLAMA_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(ollamaRequest),
  });

  console.log("[DA][Ollama] HTTP response", {
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const body = await response.json();
  console.log("[DA][Ollama] Response body", body);
  const text = body?.choices?.[0]?.text;
  console.log("[DA][Ollama] Completion text", text);
  const result = parseStrictJsonObject(text);
  console.log("[DA][Ollama] Parsed JSON", result);

  if (typeof result.path !== "string" || result.path.trim() === "") {
    throw new Error("LLM response did not include a path");
  }

  const relativeLaunchPath = result.path.trim().replace(/\\/g, "/");

  if (path.isAbsolute(relativeLaunchPath)) {
    throw new Error("LLM returned an absolute path");
  }

  const launchFilePath = path.resolve(extractDir, relativeLaunchPath);

  assertInside(extractDir, launchFilePath);

  if (!fs.existsSync(launchFilePath) || !fs.statSync(launchFilePath).isFile()) {
    throw new Error(`LLM selected a missing file: ${relativeLaunchPath}`);
  }

  console.log("[DA][Ollama] Selected launch file", {
    relativeLaunchPath,
    launchFilePath,
  });

  return launchFilePath;
}

async function prepareDownloadedFile(file, downloadedFilePath) {
  const sourceFilePath = normalizeDownloadedPath(downloadedFilePath);

  if (!sourceFilePath) {
    throw new Error("downloadedFilePath is required");
  }

  if (!fs.existsSync(sourceFilePath) || !fs.statSync(sourceFilePath).isFile()) {
    throw new Error(`Downloaded file does not exist: ${sourceFilePath}`);
  }

  const managedRoot = getManagedTempRoot(sourceFilePath);
  const caseDir = path.join(
    managedRoot,
    "cases",
    `${safeSegment(file.caseKey, "case")}-${hashKey(file.caseKey).slice(0, 12)}`,
  );
  const fileDir = path.join(
    caseDir,
    `${safeSegment(file.fileName, "file")}-${hashKey(file.fileId).slice(0, 12)}`,
  );
  const originalDir = path.join(fileDir, "original");
  const extractDir = path.join(fileDir, "extracted");

  fs.rmSync(fileDir, { recursive: true, force: true });
  fs.mkdirSync(fileDir, { recursive: true });

  console.log("[DA] Moving browser download into managed temp", {
    sourceFilePath,
    fileDir,
  });
  const managedSourcePath = await moveSourceToManaged(
    sourceFilePath,
    originalDir,
    file.fileName || path.basename(sourceFilePath),
  );

  const extension = path.extname(managedSourcePath).toLowerCase();

  if (extension === ".inv" || extension === ".dcm") {
    return {
      managedFilePath: managedSourcePath,
      launchFilePath: managedSourcePath,
      launchFileUrl: pathToFileUrl(managedSourcePath),
    };
  }

  if (extension !== ".zip") {
    throw new Error(`Unsupported downloaded file type: ${extension || "none"}`);
  }

  console.log("[DA] Extracting zip into managed temp", {
    managedSourcePath,
    extractDir,
  });
  await extractZipSafely(managedSourcePath, extractDir);

  const launchFilePath = await chooseLaunchFileWithOllama(extractDir);

  return {
    managedFilePath: managedSourcePath,
    launchFilePath,
    launchFileUrl: pathToFileUrl(launchFilePath),
  };
}

function getDownloadAgentJobKey(file) {
  return `${file.caseKey}\n${file.fileId}`;
}

function queueDownloadAgentPreparation(file, downloadedFilePath) {
  const jobKey = getDownloadAgentJobKey(file);

  if (activeDownloadAgentJobs.has(jobKey)) {
    console.log("[DA] Preparation job already running", {
      caseKey: file.caseKey,
      fileId: file.fileId,
    });
    return;
  }

  console.log("[DA] Queueing server preparation job", {
    caseKey: file.caseKey,
    fileId: file.fileId,
    downloadedFilePath,
  });

  const job = runDownloadAgentPreparation(file, downloadedFilePath).finally(
    () => {
      activeDownloadAgentJobs.delete(jobKey);
    },
  );

  activeDownloadAgentJobs.set(jobKey, job);
}

async function runDownloadAgentPreparation(file, downloadedFilePath) {
  const state = readCaseState(file.caseKey);
  const fileState = getOrCreateFileState(state, file);

  try {
    console.log("[DA] Server preparation started", {
      caseKey: file.caseKey,
      fileId: file.fileId,
      downloadedFilePath,
    });
    const prepared = await prepareDownloadedFile(file, downloadedFilePath);

    fileState.status = DA_STATUS.READY;
    fileState.phase = "ready";
    fileState.sourceFilePath = normalizeDownloadedPath(downloadedFilePath);
    fileState.managedFilePath = prepared.managedFilePath;
    fileState.launchFilePath = prepared.launchFilePath;
    fileState.launchFileUrl = prepared.launchFileUrl;
    fileState.error = null;
    fileState.updatedAt = nowIso();

    writeCaseState(state);
    console.log("[DA] File ready", {
      fileId: file.fileId,
      launchFilePath: prepared.launchFilePath,
      launchFileUrl: prepared.launchFileUrl,
    });
  } catch (error) {
    console.error("[DA] Preparation failed:", error);
    fileState.status = DA_STATUS.FAILED;
    fileState.phase = "failed";
    fileState.error = error.message;
    fileState.updatedAt = nowIso();
    writeCaseState(state);
  }
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

function createDownloadAgentJobHandler() {
  return (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    console.log("[DA] Job started", file);
    const state = readCaseState(file.caseKey);
    const fileState = getOrCreateFileState(state, file);

    fileState.status = DA_STATUS.PREPARING;
    fileState.phase = "downloading";
    fileState.error = null;
    fileState.launchFileUrl = null;
    fileState.updatedAt = nowIso();

    writeCaseState(state);
    res.json(stateForResponse(state));
  };
}

function createDownloadAgentCompleteHandler() {
  return (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    const { downloadedFilePath } = req.body || {};
    const state = readCaseState(file.caseKey);
    const fileState = getOrCreateFileState(state, file);

    fileState.status = DA_STATUS.PREPARING;
    fileState.phase = "unpacking";
    fileState.error = null;
    fileState.updatedAt = nowIso();
    writeCaseState(state);

    console.log("[DA] Browser download completed; preparation queued", {
      caseKey: file.caseKey,
      fileId: file.fileId,
      downloadedFilePath,
    });
    queueDownloadAgentPreparation(file, downloadedFilePath);

    res.json(stateForResponse(state));
  };
}

function createDownloadAgentFailHandler() {
  return (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    const state = readCaseState(file.caseKey);
    const fileState = getOrCreateFileState(state, file);

    console.log("[DA] Browser download failed", {
      caseKey: file.caseKey,
      fileId: file.fileId,
      error: req.body?.error,
    });

    fileState.status = DA_STATUS.FAILED;
    fileState.phase = "failed";
    fileState.error =
      typeof req.body?.error === "string" && req.body.error.trim() !== ""
        ? req.body.error.trim()
        : "Browser download failed";
    fileState.updatedAt = nowIso();

    writeCaseState(state);
    res.json(stateForResponse(state));
  };
}

function createDownloadAgentOpenHandler() {
  return async (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    const state = readCaseState(file.caseKey);
    const fileState = state.files[file.fileId];

    if (!fileState || fileState.status !== DA_STATUS.READY) {
      res.status(409).json({ error: "File is not ready to view" });
      return;
    }

    try {
      await openFileWithOs(fileState.launchFilePath);
      res.json({ ok: true });
    } catch (error) {
      console.error("[DA] Open failed:", error);

      if (error.message === "Prepared launch file is missing") {
        resetFileStateToNotDownloaded(fileState);
        writeCaseState(state);
      }

      res.status(500).json({ error: error.message });
    }
  };
}

function createDownloadAgentStateHandler() {
  return (req, res) => {
    const caseKey = req.query.caseKey;

    if (typeof caseKey !== "string" || caseKey.trim() === "") {
      res.status(400).json({ error: "caseKey is required" });
      return;
    }

    const state = refreshCaseStateFromDisk(readCaseState(caseKey.trim()));

    res.json(stateForResponse(state));
  };
}

function createApp({ templateDir = DEFAULT_TEMPLATE_DIR } = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/templates", createTemplateListHandler(templateDir));
  app.post("/generate_document", createDocumentGenerationHandler(templateDir));
  app.post("/download-agent/jobs", createDownloadAgentJobHandler());
  app.post("/download-agent/complete", createDownloadAgentCompleteHandler());
  app.post("/download-agent/fail", createDownloadAgentFailHandler());
  app.post("/download-agent/open", createDownloadAgentOpenHandler());
  app.get("/download-agent/state", createDownloadAgentStateHandler());

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
  createDownloadAgentCompleteHandler,
  createDownloadAgentFailHandler,
  createDownloadAgentJobHandler,
  createDownloadAgentOpenHandler,
  createDownloadAgentStateHandler,
  createTemplateListHandler,
  listTemplates,
  renderDocument,
  resolveTemplatePath,
};
