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
const DA_TEMP_DIR = process.env.DA_TEMP_DIR || null;
const OLLAMA_CHAT_COMPLETIONS_URL =
  process.env.OLLAMA_CHAT_COMPLETIONS_URL ||
  "http://localhost:11434/v1/chat/completions";
const OLLAMA_MODEL = "llama3.2:latest";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DA_STATUS = Object.freeze({
  NOT_DOWNLOADED: "not_downloaded",
  PREPARING: "preparing",
  READY: "ready",
  FAILED: "failed",
});
const activeDownloadAgentJobs = new Map();
const activeDownloadAgentPhases = new Map();

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

function getWslUsernameCandidates() {
  return Array.from(
    new Set(
      [
        process.env.USER,
        process.env.LOGNAME,
        process.env.HOME ? path.basename(process.env.HOME) : null,
      ].filter((value) => typeof value === "string" && value.trim() !== ""),
    ),
  );
}

function listWslWindowsUserTempDirs() {
  if (!isWsl() || !fs.existsSync("/mnt")) {
    return [];
  }

  const tempDirs = [];

  for (const driveName of ["c", "C"]) {
    const usersDir = path.join("/mnt", driveName.toLowerCase(), "Users");

    for (const username of getWslUsernameCandidates()) {
      const tempDir = path.join(usersDir, username, "AppData/Local/Temp");

      if (fs.existsSync(path.dirname(tempDir))) {
        tempDirs.push(tempDir);
      }
    }
  }

  try {
    for (const drive of fs.readdirSync("/mnt", { withFileTypes: true })) {
      if (!drive.isDirectory()) {
        continue;
      }

      const usersDir = path.join("/mnt", drive.name, "Users");

      if (!fs.existsSync(usersDir)) {
        continue;
      }

      for (const user of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (!user.isDirectory()) {
          continue;
        }

        const tempDir = path.join(usersDir, user.name, "AppData/Local/Temp");

        if (fs.existsSync(tempDir)) {
          tempDirs.push(tempDir);
        }
      }
    }
  } catch (error) {
    console.error("[DA] Could not scan WSL Windows temp roots:", error);
  }

  return uniquePaths(tempDirs);
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

    const defaultWindowsTemp = listWslWindowsUserTempDirs()[0];

    if (defaultWindowsTemp) {
      return path.join(defaultWindowsTemp, "radiodash-download-agent");
    }

    throw new Error(
      "Could not resolve Windows AppData Local Temp under WSL; set DA_TEMP_DIR",
    );
  }

  return path.join(os.tmpdir(), "radiodash-download-agent");
}

function getCaseDir(managedRoot, caseKey) {
  return path.join(
    managedRoot,
    "cases",
    `${safeSegment(caseKey, "case")}-${hashKey(caseKey).slice(0, 12)}`,
  );
}

function getCaseStatePath(managedRoot, caseKey) {
  return path.join(getCaseDir(managedRoot, caseKey), "state.json");
}

function createEmptyCaseState(caseKey) {
  return {
    caseKey,
    files: {},
  };
}

function attachStateRoot(state, managedRoot) {
  Object.defineProperty(state, "__managedRoot", {
    value: managedRoot,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return state;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getStateUpdatedTime(state) {
  return Math.max(
    0,
    ...Object.values(state.files || {}).map((fileState) => {
      const time = Date.parse(fileState.updatedAt || "");
      return Number.isFinite(time) ? time : 0;
    }),
  );
}

function shouldUseIncomingFileState(currentFileState, incomingFileState) {
  if (!currentFileState) {
    return true;
  }

  const currentTime = Date.parse(currentFileState.updatedAt || "");
  const incomingTime = Date.parse(incomingFileState.updatedAt || "");

  if (!Number.isFinite(currentTime)) {
    return true;
  }

  if (!Number.isFinite(incomingTime)) {
    return false;
  }

  return incomingTime >= currentTime;
}

function mergeCaseState(target, incoming) {
  if (!incoming?.files) {
    return target;
  }

  Object.entries(incoming.files).forEach(([fileId, incomingFileState]) => {
    if (shouldUseIncomingFileState(target.files[fileId], incomingFileState)) {
      target.files[fileId] = {
        ...incomingFileState,
        fileId: incomingFileState.fileId || fileId,
      };
    }
  });

  return target;
}

function listWslWindowsManagedTempRoots() {
  return listWslWindowsUserTempDirs().map((tempDir) =>
    path.join(tempDir, "radiodash-download-agent"),
  );
}

function uniquePaths(paths) {
  const seen = new Set();

  return paths.filter((filePath) => {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return false;
    }

    const resolved = path.resolve(filePath);

    if (seen.has(resolved)) {
      return false;
    }

    seen.add(resolved);
    return true;
  });
}

function getCandidateManagedRoots(preferredRoot = null) {
  if (DA_TEMP_DIR) {
    return [DA_TEMP_DIR];
  }

  return uniquePaths([
    preferredRoot,
    getManagedTempRoot(""),
    ...listWslWindowsManagedTempRoots(),
  ]);
}

function readCaseStateRecord(caseKey, managedRoot) {
  const statePath = getCaseStatePath(managedRoot, caseKey);

  if (!fs.existsSync(statePath)) {
    return null;
  }

  return {
    managedRoot,
    state: readJsonFile(statePath),
  };
}

function readCaseState(caseKey, preferredRoot = null) {
  const state = createEmptyCaseState(caseKey);
  let selectedRoot = preferredRoot || null;
  let newestRecord = null;

  for (const managedRoot of getCandidateManagedRoots(preferredRoot)) {
    const record = readCaseStateRecord(caseKey, managedRoot);

    if (!record) {
      continue;
    }

    mergeCaseState(state, record.state);

    if (
      !newestRecord ||
      getStateUpdatedTime(record.state) >
        getStateUpdatedTime(newestRecord.state)
    ) {
      newestRecord = record;
    }
  }

  selectedRoot =
    selectedRoot || newestRecord?.managedRoot || getManagedTempRoot("");

  return attachStateRoot(state, selectedRoot);
}

function writeCaseState(state, managedRoot = state.__managedRoot) {
  const stateRoot = managedRoot || getManagedTempRoot("");
  const statePath = getCaseStatePath(stateRoot, state.caseKey);

  attachStateRoot(state, stateRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  return state;
}

function getFileDir(caseDir, file) {
  return path.join(
    caseDir,
    `${safeSegment(file.fileName, "file")}-${hashKey(file.fileId).slice(0, 12)}`,
  );
}

function getDownloadAgentJobKey(file) {
  return `${file.caseKey}\n${file.fileId}`;
}

function setActiveDownloadAgentPhase(file, phase) {
  activeDownloadAgentPhases.set(getDownloadAgentJobKey(file), phase);
}

function clearActiveDownloadAgentPhase(file) {
  activeDownloadAgentPhases.delete(getDownloadAgentJobKey(file));
}

function hasActiveDownloadAgentWork(caseKey, fileId) {
  const jobKey = `${caseKey}\n${fileId}`;

  return (
    activeDownloadAgentJobs.has(jobKey) || activeDownloadAgentPhases.has(jobKey)
  );
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

function fileExists(filePath) {
  if (typeof filePath !== "string" || filePath === "") {
    return false;
  }

  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function refreshFileStateFromDisk(state, fileId, fileState) {
  if (fileState.status === DA_STATUS.READY) {
    if (fileExists(fileState.launchFilePath)) {
      return false;
    }

    console.log("[DA] Ready launch file missing; removing persisted state", {
      fileId: fileState.fileId,
      launchFilePath: fileState.launchFilePath,
    });
    delete state.files[fileId];
    return true;
  }

  if (fileState.status === DA_STATUS.PREPARING) {
    if (hasActiveDownloadAgentWork(state.caseKey, fileState.fileId)) {
      return false;
    }

    console.log("[DA] Stale preparing state; resetting to Prepare", {
      fileId: fileState.fileId,
      phase: fileState.phase,
    });
    resetFileStateToNotDownloaded(fileState);
    return true;
  }

  if (
    fileState.status === DA_STATUS.FAILED &&
    fileExists(fileState.launchFilePath)
  ) {
    fileState.status = DA_STATUS.READY;
    fileState.phase = "ready";
    fileState.error = null;
    fileState.launchFileUrl = pathToFileUrl(fileState.launchFilePath);
    fileState.updatedAt = nowIso();
    return true;
  }

  return false;
}

function refreshCaseStateFromDisk(state) {
  let changed = false;

  Object.entries(state.files).forEach(([fileId, fileState]) => {
    if (refreshFileStateFromDisk(state, fileId, fileState)) {
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

    console.log(
      "[DA] Rename crossed filesystems; falling back to copy+unlink",
      {
        sourceFilePath,
        destinationPath,
      },
    );
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

async function listZipFiles(rootDir) {
  const zipFiles = [];

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.resolve(dir, entry.name);
      assertInside(rootDir, entryPath);

      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (
        entry.isFile() &&
        path.extname(entry.name).toLowerCase() === ".zip"
      ) {
        zipFiles.push(entryPath);
      }
    }
  }

  await walk(rootDir);

  return zipFiles;
}

async function extractNestedZipsInPlace(rootDir) {
  let depth = 0;
  const maxDepth = 10;

  while (true) {
    const nestedZipPaths = await listZipFiles(rootDir);

    if (nestedZipPaths.length === 0) {
      return;
    }

    if (depth >= maxDepth) {
      throw new Error(`Nested zip extraction exceeded ${maxDepth} levels`);
    }

    depth += 1;

    console.log("[DA] Found nested zip files after extraction", {
      rootDir,
      depth,
      count: nestedZipPaths.length,
      nestedZipPaths,
    });

    for (const nestedZipPath of nestedZipPaths) {
      const destinationDir = path.join(
        path.dirname(nestedZipPath),
        path.basename(nestedZipPath, path.extname(nestedZipPath)),
      );
      assertInside(rootDir, destinationDir);

      console.log("[DA] Extracting nested zip in place", {
        nestedZipPath,
        destinationDir,
      });

      await extractZipSafely(nestedZipPath, destinationDir);
      await fs.promises.unlink(nestedZipPath);

      console.log("[DA] Removed nested zip after extraction", {
        nestedZipPath,
      });
    }
  }
}

async function buildAbridgedTree(rootDir) {
  const lines = ["."];
  const maxFilesPerDirectory = 10;

  async function walk(dir, prefix) {
    const entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
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

function compareDirectoryEntries(a, b) {
  if (a.isDirectory() && !b.isDirectory()) return -1;
  if (!a.isDirectory() && b.isDirectory()) return 1;
  return a.name.localeCompare(b.name);
}

function toLlmRelativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

function getExtensionLabel(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return extension || "[no extension]";
}

function isLikelyLaunchFileName(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const baseName = path.basename(fileName, extension);

  return (
    extension === ".inv" ||
    extension === ".dcm" ||
    /^\d+$/.test(baseName) ||
    /^i\d+$/i.test(baseName) ||
    /dicom/i.test(fileName)
  );
}

function summarizeFileEntries(files) {
  const extensionCounts = new Map();

  files.forEach((entry) => {
    const extension = getExtensionLabel(entry.name);
    extensionCounts.set(extension, (extensionCounts.get(extension) || 0) + 1);
  });

  return Array.from(extensionCounts.entries())
    .sort(([leftExtension], [rightExtension]) =>
      leftExtension.localeCompare(rightExtension),
    )
    .map(([extension, count]) => `${extension}: ${count}`)
    .join(", ");
}

function pickRepresentativeFileEntries(files, maxFilesPerDirectory) {
  const selected = [];
  const seenNames = new Set();

  function add(entry) {
    if (!entry || seenNames.has(entry.name)) {
      return;
    }

    selected.push(entry);
    seenNames.add(entry.name);
  }

  files.filter((entry) => isLikelyLaunchFileName(entry.name)).forEach(add);
  files.slice(0, maxFilesPerDirectory).forEach(add);

  return selected
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxFilesPerDirectory);
}

async function buildLlmAbridgedTree(rootDir) {
  const lines = [
    "The root directory is represented by .",
    "Only choose a launch file from an exact relativePath value shown below.",
    "Directory names and file names are JSON-quoted so spaces and punctuation are significant.",
    "",
  ];
  const maxFilesPerDirectory = 12;
  const maxDirectories = 5;
  const directories = [];

  async function collect(dir, relativeDir) {
    const entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .sort(compareDirectoryEntries);
    const dirs = entries.filter((entry) => entry.isDirectory());
    const files = entries.filter((entry) => entry.isFile());

    directories.push({
      dir,
      relativeDir,
      dirs,
      files,
    });

    for (const entry of dirs) {
      const childRelativeDir = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;

      await collect(path.join(dir, entry.name), childRelativeDir);
    }

    await waitForNextTick();
  }

  await collect(rootDir, "");

  directories.sort((a, b) => {
    const fileCountDifference = b.files.length - a.files.length;

    if (fileCountDifference !== 0) {
      return fileCountDifference;
    }

    return (a.relativeDir || ".").localeCompare(b.relativeDir || ".");
  });

  for (const { dir, relativeDir, dirs, files } of directories.slice(
    0,
    maxDirectories,
  )) {
    const displayDir = relativeDir || ".";

    lines.push(`Directory ${JSON.stringify(displayDir)}`);
    lines.push(`- subdirectoryCount: ${dirs.length}`);
    lines.push(`- fileCount: ${files.length}`);

    if (files.length > 0) {
      lines.push(`- fileTypes: ${summarizeFileEntries(files)}`);
      lines.push("- files:");

      for (const entry of pickRepresentativeFileEntries(
        files,
        maxFilesPerDirectory,
      )) {
        const absoluteFilePath = path.join(dir, entry.name);
        const relativePath = toLlmRelativePath(rootDir, absoluteFilePath);
        const stats = await fs.promises.stat(absoluteFilePath);

        lines.push(
          `  - relativePath: ${JSON.stringify(relativePath)} | sizeBytes: ${stats.size}`,
        );
      }

      if (files.length > maxFilesPerDirectory) {
        lines.push(
          `  - omittedFilesInThisDirectory: ${files.length - maxFilesPerDirectory}`,
        );
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
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
  const tree = await buildLlmAbridgedTree(extractDir);
  const systemPrompt = `You select the launch file for Invivo dental imaging cases.

Return only strict JSON in this exact shape:
{"path":"relative/path/to/launch-file"}

- Choose the single most likely FILE the radiologist should open.
- Do not choose a directory, always choose a FILE.
- The most likely launch file is a numbered file that exists next to a lot of other numbered files. These are DICOM slices.
- The path must exactly match one relativePath value for a FILE from the given directory tree. 
`;

  const userMessage = `Directory tree:
${tree}`;
  const ollamaRequest = {
    model: OLLAMA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0,
    max_tokens: 200,
    stream: false,
  };

  console.log("[DA][Ollama] Request", {
    url: OLLAMA_CHAT_COMPLETIONS_URL,
    model: OLLAMA_MODEL,
    extractDir,
  });
  console.log("[DA][Ollama] System prompt\n" + systemPrompt);
  console.log("[DA][Ollama] User message\n" + userMessage);
  const response = await fetch(OLLAMA_CHAT_COMPLETIONS_URL, {
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
  const text = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text;
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
  const caseDir = getCaseDir(managedRoot, file.caseKey);
  const fileDir = getFileDir(caseDir, file);
  const workDir = path.join(
    caseDir,
    `${path.basename(fileDir)}.work-${process.pid}-${Date.now()}`,
  );
  const originalDir = path.join(workDir, "original");
  const extractDir = path.join(workDir, "extracted");

  try {
    await fs.promises.mkdir(caseDir, { recursive: true });
    await fs.promises.rm(workDir, { recursive: true, force: true });
    await fs.promises.mkdir(workDir, { recursive: true });

    console.log("[DA] Moving browser download into managed temp work dir", {
      sourceFilePath,
      workDir,
      fileDir,
    });
    const workManagedSourcePath = await moveSourceToManaged(
      sourceFilePath,
      originalDir,
      file.fileName || path.basename(sourceFilePath),
    );

    const extension = path.extname(workManagedSourcePath).toLowerCase();
    let workLaunchFilePath = workManagedSourcePath;

    if (extension === ".zip") {
      console.log("[DA] Extracting zip into managed temp work dir", {
        managedSourcePath: workManagedSourcePath,
        extractDir,
      });
      await extractZipSafely(workManagedSourcePath, extractDir);
      await extractNestedZipsInPlace(extractDir);
      workLaunchFilePath = await chooseLaunchFileWithOllama(extractDir);
    } else if (extension !== ".inv" && extension !== ".dcm") {
      throw new Error(
        `Unsupported downloaded file type: ${extension || "none"}`,
      );
    }

    await promotePreparedWorkDir(workDir, fileDir);

    const managedFilePath = rebasePreparedPath(
      workManagedSourcePath,
      workDir,
      fileDir,
    );
    const launchFilePath = rebasePreparedPath(
      workLaunchFilePath,
      workDir,
      fileDir,
    );

    return {
      managedRoot,
      managedFilePath,
      launchFilePath,
      launchFileUrl: pathToFileUrl(launchFilePath),
    };
  } catch (error) {
    await fs.promises
      .rm(workDir, { recursive: true, force: true })
      .catch(() => {});
    throw error;
  }
}

function rebasePreparedPath(filePath, oldRoot, newRoot) {
  const relativePath = path.relative(oldRoot, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Prepared path is outside work directory: ${filePath}`);
  }

  return path.join(newRoot, relativePath);
}

async function promotePreparedWorkDir(workDir, fileDir) {
  const backupDir = `${fileDir}.backup-${process.pid}-${Date.now()}`;
  let hasBackup = false;

  await fs.promises.rm(backupDir, { recursive: true, force: true });

  try {
    if (fs.existsSync(fileDir)) {
      await fs.promises.rename(fileDir, backupDir);
      hasBackup = true;
    }

    await fs.promises.rename(workDir, fileDir);

    if (hasBackup) {
      await fs.promises.rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (hasBackup && !fs.existsSync(fileDir)) {
      await fs.promises.rename(backupDir, fileDir).catch((restoreError) => {
        console.error("[DA] Failed to restore previous prepared directory:", {
          fileDir,
          backupDir,
          restoreError,
        });
      });
    }

    throw error;
  }
}

function queueDownloadAgentPreparation(file, downloadedFilePath, managedRoot) {
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

  const job = runDownloadAgentPreparation(
    file,
    downloadedFilePath,
    managedRoot,
  ).finally(() => {
    activeDownloadAgentJobs.delete(jobKey);
  });

  activeDownloadAgentJobs.set(jobKey, job);
}

async function runDownloadAgentPreparation(
  file,
  downloadedFilePath,
  managedRoot,
) {
  const state = readCaseState(file.caseKey, managedRoot);
  const fileState = getOrCreateFileState(state, file);

  try {
    console.log("[DA] Server preparation started", {
      caseKey: file.caseKey,
      fileId: file.fileId,
      downloadedFilePath,
    });
    const prepared = await prepareDownloadedFile(file, downloadedFilePath);
    attachStateRoot(state, prepared.managedRoot);

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
  } finally {
    clearActiveDownloadAgentPhase(file);
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
    setActiveDownloadAgentPhase(file, "downloading");
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
    const sourceFilePath = normalizeDownloadedPath(downloadedFilePath);
    const managedRoot = getManagedTempRoot(sourceFilePath || "");
    setActiveDownloadAgentPhase(file, "unpacking");
    const state = readCaseState(file.caseKey, managedRoot);
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
    queueDownloadAgentPreparation(file, downloadedFilePath, managedRoot);

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
    clearActiveDownloadAgentPhase(file);

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

    const state = refreshCaseStateFromDisk(readCaseState(file.caseKey));
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
        delete state.files[file.fileId];
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
