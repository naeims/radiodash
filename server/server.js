const express = require("express");
const cors = require("cors");
const { execFileSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const yauzl = require("yauzl");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const DEFAULT_PORT = Number(process.env.PORT) || 5000;
const DEFAULT_TEMPLATE_DIR = path.resolve(__dirname, "templates");
const DA_TEMP_DIR = process.env.DA_TEMP_DIR || null;
const OLLAMA_CHAT_COMPLETIONS_URL =
  process.env.OLLAMA_CHAT_COMPLETIONS_URL ||
  "http://localhost:11434/v1/chat/completions";
const OLLAMA_MODEL = "llama3.1:8b";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const INVIVO_DENTAL_EXE =
  process.env.INVIVO_DENTAL_EXE ||
  "C:\\Program Files\\Anatomage\\InVivoDental\\InVivoDental.exe";
const IS_WSL =
  process.platform === "linux" &&
  fs.existsSync("/proc/version") &&
  fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
const DA_STATUS = Object.freeze({
  NOT_DOWNLOADED: "not_downloaded",
  PREPARING: "preparing",
  READY: "ready",
  FAILED: "failed",
});
const LLM_TREE_INSTRUCTION_LINES = Object.freeze([
  'The root directory is represented by Directory:"." - If the launch file is picked from this directory, just include the relativePath verbatim.',
  "Only choose a launch file from an exact relativePath value shown below.",
  "Directory names and file names are JSON-quoted so spaces and punctuation are significant.",
]);
const LAUNCH_FILE_SYSTEM_PROMPT = `You select the launch file for Invivo dental imaging cases.

Return only strict JSON in this exact shape:
{"paths":["relative/path/to/launch-file"]}

- Do not explain your choice. Do not include markdown or any text before or after the JSON.
- The first character of your response must be "{" and the last character must be "}".
- Usually choose exactly one FILE: the single most likely file the radiologist should open.
- Return multiple paths only when the listing shows multiple separate image-series directories that each contain hundreds of likely image files. If there is only one such image-series directory, return one path.
- When returning multiple paths, choose one representative launch file per distinct scan using the same rules below. Do not return multiple files from one image series.
- Multiple sibling or parallel directories that each contain hundreds of likely image files should be treated as separate scans unless the listing clearly shows one is only nested inside the other. Do not collapse separate image-series directories into one answer just because they share a parent directory.
- Before writing JSON, count the separate image-series directories shown in the listing. Image-series directories usually have fileCount in the hundreds and fileTypes made of likely image files such as .dcm or no-extension DICOM slices. If this count is greater than 1, the "paths" array must contain exactly one representative file from each counted image-series directory.
- Do not choose a directory, always choose a FILE.
- Each returned path must exactly match one of the values from a "- relativePath:" file line, never a Directory name or only the containing folder.
- Copy returned path strings character-for-character from the relativePath value, preserving every space, comma, hyphen, and punctuation mark.
- "." is never a valid answer. If a selected file is in Directory ".", return that file's relativePath value, such as "scan.dcm".
- Return the relativePath string contents only, without the surrounding JSON quotes shown in the directory listing.
- Apply these rules in order:
  1. If any directory contains hundreds of likely image files, choose from that image-series directory instead of small utility, viewer software, layout, resource, or COMP directories, even when a utility file is larger.
  2. For each selected directory with hundreds of likely image files, ignore sizeBytes and choose the first listed likely image file in that directory: the first "- relativePath:" file line shown under that directory's "- files:" section. Do not choose a later file because it is larger, shorter, or has a number that looks similar after removing leading zeros. For example between I0000000 and I0000010, choose I0000000; between DCM_00000.dcm and DCM_00012.dcm, choose DCM_00000.dcm. Return the full relativePath of the chosen file, not the directory path.
  3. For a directory with fewer than 10 total files made of large scan data files plus XML sidecar files, ignore the XML files and choose the non-XML scan data file with the greatest numeric sizeBytes value. In this small-bundle case, compare the sizeBytes numbers before answering; sizeBytes overrides numbered order, so do not choose CT0 just because it appears first. For example if CT0 is 20MB, CT1 is 90MB, and CT2 is 48MB, choose CT1.
- Cardinality example: if the listing has Directory "Case/Scan A" with fileCount 600 and first file "Case/Scan A/A000.dcm", and also Directory "Case/Scan B" with fileCount 600 and first file "Case/Scan B/B000.dcm", return {"paths":["Case/Scan A/A000.dcm","Case/Scan B/B000.dcm"]}. If there is only one image-series directory, return a one-element paths array.
- Final check before replying: every path in your JSON must be copied exactly from a "- relativePath:" line. If you selected a Directory line or a folder path, replace it with the correct file relativePath from that directory.
`;
const activeDownloadAgentWork = new Map();
const caseStateUpdateQueues = new Map();

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

function wslPathToWindowsLaunchPath(filePath) {
  const mountedWindowsPath = wslPathToWindowsPath(filePath);

  if (mountedWindowsPath !== filePath) {
    return mountedWindowsPath;
  }

  try {
    return execFileSync("wslpath", ["-w", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`Could not convert WSL path to Windows path: ${filePath}`);
  }
}

function normalizeDownloadedPath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return null;
  }

  if (IS_WSL) {
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

function listWslWindowsTempRoots(sourceFilePath = "") {
  if (!IS_WSL) {
    return [];
  }

  const tempDirs = [];
  const sourceTemp = sourceFilePath
    ? getWindowsUserTempFromWslPath(sourceFilePath)
    : null;

  if (sourceTemp) {
    tempDirs.push(sourceTemp);
  }

  if (!fs.existsSync("/mnt")) {
    return uniquePaths(tempDirs);
  }

  const usersDir = path.join("/mnt", "c", "Users");

  for (const username of getWslUsernameCandidates()) {
    const tempDir = path.join(usersDir, username, "AppData/Local/Temp");

    if (fs.existsSync(path.dirname(tempDir))) {
      tempDirs.push(tempDir);
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

  if (IS_WSL) {
    const windowsTemp = listWslWindowsTempRoots(sourceFilePath)[0];

    if (windowsTemp) {
      return path.join(windowsTemp, "radiodash-download-agent");
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
  return listWslWindowsTempRoots().map((tempDir) =>
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

async function deleteDownloadAgentTempRoots() {
  const roots = getCandidateManagedRoots();

  activeDownloadAgentWork.clear();

  for (const root of roots) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }

  return roots;
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

function enqueueCaseStateUpdate(caseKey, update) {
  const previous = caseStateUpdateQueues.get(caseKey) || Promise.resolve();
  const run = previous.catch(() => {}).then(update);
  const next = run
    .catch(() => {})
    .finally(() => {
      if (caseStateUpdateQueues.get(caseKey) === next) {
        caseStateUpdateQueues.delete(caseKey);
      }
    });

  caseStateUpdateQueues.set(caseKey, next);
  return run;
}

function updateCaseState(caseKey, preferredRoot, update) {
  return enqueueCaseStateUpdate(caseKey, async () => {
    const state = readCaseState(caseKey, preferredRoot);
    const result = await update(state);

    writeCaseState(state);
    return result === undefined ? state : result;
  });
}

function updateFileState(file, preferredRoot, update) {
  return updateCaseState(file.caseKey, preferredRoot, async (state) => {
    const fileState = getOrCreateFileState(state, file);
    const result = await update(fileState, state);

    return result === undefined ? state : result;
  });
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

function setActiveDownloadAgentWork(file, phase, job = null) {
  const jobKey = getDownloadAgentJobKey(file);
  const current = activeDownloadAgentWork.get(jobKey) || {};

  activeDownloadAgentWork.set(jobKey, {
    ...current,
    phase,
    job: job || current.job || null,
  });
}

function clearActiveDownloadAgentWork(file) {
  activeDownloadAgentWork.delete(getDownloadAgentJobKey(file));
}

function hasActiveDownloadAgentWork(caseKey, fileId) {
  return activeDownloadAgentWork.has(`${caseKey}\n${fileId}`);
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
  fileState.launchFilePaths = null;
  fileState.launchFileUrl = null;
  fileState.launchFileUrls = null;
  fileState.launchFileLabels = null;
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

function getFileStateLaunchFilePaths(fileState) {
  if (Array.isArray(fileState.launchFilePaths)) {
    return fileState.launchFilePaths.filter(
      (filePath) => typeof filePath === "string" && filePath.trim() !== "",
    );
  }

  if (
    typeof fileState.launchFilePath === "string" &&
    fileState.launchFilePath.trim() !== ""
  ) {
    return [fileState.launchFilePath];
  }

  return [];
}

function getFileStateLaunchFileUrls(fileState) {
  if (Array.isArray(fileState.launchFileUrls)) {
    return fileState.launchFileUrls.filter(
      (fileUrl) => typeof fileUrl === "string" && fileUrl.trim() !== "",
    );
  }

  if (
    typeof fileState.launchFileUrl === "string" &&
    fileState.launchFileUrl.trim() !== ""
  ) {
    return [fileState.launchFileUrl];
  }

  return getFileStateLaunchFilePaths(fileState).map(pathToFileUrl);
}

function getFileStateLaunchFileLabels(fileState) {
  if (Array.isArray(fileState.launchFileLabels)) {
    return fileState.launchFileLabels.map((label) =>
      typeof label === "string" && label.trim() !== "" ? label.trim() : null,
    );
  }

  return [];
}

function createLaunchFileChoices(fileState) {
  const paths = getFileStateLaunchFilePaths(fileState);
  const urls = getFileStateLaunchFileUrls(fileState);
  const labels = getFileStateLaunchFileLabels(fileState);

  return paths.map((filePath, index) => ({
    index,
    label: labels[index] || path.basename(filePath) || `Scan ${index + 1}`,
    launchFileUrl: urls[index] || pathToFileUrl(filePath),
  }));
}

function refreshFileStateFromDisk(state, fileId, fileState) {
  if (fileState.status === DA_STATUS.READY) {
    const launchFilePaths = getFileStateLaunchFilePaths(fileState);

    if (
      launchFilePaths.length > 0 &&
      launchFilePaths.every((launchFilePath) => fileExists(launchFilePath))
    ) {
      return false;
    }

    console.log("[DA] Ready launch file missing; removing persisted state", {
      fileId: fileState.fileId,
      launchFilePaths,
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
    getFileStateLaunchFilePaths(fileState).every((launchFilePath) =>
      fileExists(launchFilePath),
    )
  ) {
    const launchFilePaths = getFileStateLaunchFilePaths(fileState);

    if (launchFilePaths.length === 0) {
      return false;
    }

    fileState.status = DA_STATUS.READY;
    fileState.phase = "ready";
    fileState.error = null;
    fileState.launchFilePath = launchFilePaths[0];
    fileState.launchFilePaths = launchFilePaths;
    fileState.launchFileUrl = pathToFileUrl(launchFilePaths[0]);
    fileState.launchFileUrls = launchFilePaths.map(pathToFileUrl);
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
          launchFileUrls: getFileStateLaunchFileUrls(fileState),
          launchFiles: createLaunchFileChoices(fileState),
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

function quoteCommandArgForLog(value) {
  const text = String(value);

  if (text === "") {
    return '""';
  }

  if (!/[\s"]/u.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '\\"')}"`;
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    console.log("[DA] Spawning detached process", {
      command,
      args,
      commandLine: [command, ...args].map(quoteCommandArgForLog).join(" "),
    });

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

function getInvivoLaunchFilePath(filePath) {
  if (IS_WSL) {
    return wslPathToWindowsLaunchPath(filePath);
  }

  return path.normalize(filePath);
}

function getPowerShellInvivoLaunchCommand(launchFilePath) {
  return [
    `$launchFilePath = ${quotePowerShellSingle(launchFilePath)}`,
    `Start-Process -FilePath ${quotePowerShellSingle(INVIVO_DENTAL_EXE)} -ArgumentList ('"{0}"' -f $launchFilePath)`,
  ].join("; ");
}

async function launchFileWithInvivoDental(filePath) {
  if (
    !filePath ||
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile()
  ) {
    throw new Error("Prepared launch file is missing");
  }

  const launchFilePath = getInvivoLaunchFilePath(filePath);

  console.log("[DA] Opening launch file with InVivoDental", {
    executablePath: INVIVO_DENTAL_EXE,
    filePath,
    launchFilePath,
  });

  if (IS_WSL) {
    await spawnDetached("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      getPowerShellInvivoLaunchCommand(launchFilePath),
    ]);
    return;
  }

  if (process.platform === "win32") {
    await spawnDetached(INVIVO_DENTAL_EXE, [launchFilePath]);
    return;
  }

  throw new Error("InVivoDental launch is only supported on Windows or WSL");
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

function openZipFile(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(zipfile);
    });
  });
}

function openZipEntryReadStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(readStream);
    });
  });
}

function getSafeZipEntry(destinationDir, entryName) {
  const normalizedEntryName = String(entryName).replace(/\\/g, "/");

  if (
    normalizedEntryName === "" ||
    normalizedEntryName.includes("\0") ||
    path.posix.isAbsolute(normalizedEntryName) ||
    path.win32.isAbsolute(normalizedEntryName) ||
    normalizedEntryName.split("/").includes("..")
  ) {
    throw new Error(`Unsafe zip entry path: ${entryName}`);
  }

  const destinationPath = path.resolve(destinationDir, normalizedEntryName);
  assertInside(destinationDir, destinationPath);

  return {
    destinationPath,
    isDirectory: normalizedEntryName.endsWith("/"),
  };
}

async function extractZipSafely(zipPath, destinationDir) {
  const zipfile = await openZipFile(zipPath);

  await fs.promises.mkdir(destinationDir, { recursive: true });

  return new Promise((resolve, reject) => {
    let pendingEntry = Promise.resolve();
    let settled = false;

    function finish(error = null) {
      if (settled) {
        return;
      }

      settled = true;
      zipfile.close();

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    async function extractEntry(entry) {
      const { destinationPath, isDirectory } = getSafeZipEntry(
        destinationDir,
        entry.fileName,
      );

      if (isDirectory) {
        await fs.promises.mkdir(destinationPath, { recursive: true });
        return;
      }

      await fs.promises.mkdir(path.dirname(destinationPath), {
        recursive: true,
      });

      const readStream = await openZipEntryReadStream(zipfile, entry);
      await pipeline(readStream, fs.createWriteStream(destinationPath));
    }

    zipfile.on("entry", (entry) => {
      pendingEntry = pendingEntry
        .then(() => extractEntry(entry))
        .then(() => zipfile.readEntry(), finish);
    });
    zipfile.once("end", () => pendingEntry.then(() => finish(), finish));
    zipfile.once("error", finish);
    zipfile.readEntry();
  });
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
  const lines = [...LLM_TREE_INSTRUCTION_LINES, "", ""];
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

function buildLaunchFileSelectionTree(directoryListing) {
  const listing = String(directoryListing || "").trim();

  return [...LLM_TREE_INSTRUCTION_LINES, "", "", listing].join("\n").trim();
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

function normalizeLaunchFileSelectionPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("LLM response included an empty path");
  }

  const relativeLaunchPath = value.trim().replace(/\\/g, "/");

  if (
    path.isAbsolute(relativeLaunchPath) ||
    path.win32.isAbsolute(relativeLaunchPath)
  ) {
    throw new Error("LLM returned an absolute path");
  }

  return relativeLaunchPath;
}

function normalizeLaunchFileSelectionResult(result) {
  const rawPaths = Array.isArray(result.paths)
    ? result.paths
    : typeof result.path === "string"
      ? [result.path]
      : null;

  if (!rawPaths || rawPaths.length === 0) {
    throw new Error("LLM response did not include paths");
  }

  const seen = new Set();
  const paths = [];

  rawPaths.forEach((rawPath) => {
    const relativeLaunchPath = normalizeLaunchFileSelectionPath(rawPath);

    if (!seen.has(relativeLaunchPath)) {
      seen.add(relativeLaunchPath);
      paths.push(relativeLaunchPath);
    }
  });

  if (paths.length === 0) {
    throw new Error("LLM response did not include paths");
  }

  return { paths };
}

function formatLaunchFileSelectionJson(value) {
  const parsed =
    typeof value === "string" ? parseStrictJsonObject(value) : value;
  const result = normalizeLaunchFileSelectionResult(parsed);

  return JSON.stringify(result, null, 2);
}

function createLaunchFileSelectionMessages(tree) {
  const systemPrompt = LAUNCH_FILE_SYSTEM_PROMPT;
  const userMessage = `Directory tree:
${tree}`;

  return {
    systemPrompt,
    userMessage,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  };
}

function createLaunchFileSelectionRequest(tree) {
  const { messages } = createLaunchFileSelectionMessages(tree);

  return {
    model: OLLAMA_MODEL,
    messages,
    temperature: 0,
    max_tokens: 300,
    stream: false,
  };
}

async function requestOllamaCompletionText(
  ollamaRequest,
  {
    url = OLLAMA_CHAT_COMPLETIONS_URL,
    fetchImpl = fetch,
    logger = console,
  } = {},
) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(ollamaRequest),
  });

  logger?.log?.("[DA][Ollama] HTTP response", {
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const body = await response.json();
  logger?.log?.("[DA][Ollama] Response body", body);
  const text = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text;
  logger?.log?.("[DA][Ollama] Completion text", text);

  return text;
}

async function chooseLaunchFileFromTreeWithOllama(tree, options = {}) {
  const logger = options.logger ?? console;
  const ollamaRequest = createLaunchFileSelectionRequest(tree);
  const text = await requestOllamaCompletionText(ollamaRequest, options);
  const result = parseStrictJsonObject(text);

  logger?.log?.("[DA][Ollama] Parsed JSON", result);

  return normalizeLaunchFileSelectionResult(result);
}

async function chooseLaunchFilesWithOllama(extractDir) {
  const tree = await buildLlmAbridgedTree(extractDir);
  const { systemPrompt, userMessage } = createLaunchFileSelectionMessages(tree);

  console.log("[DA][Ollama] Request", {
    url: OLLAMA_CHAT_COMPLETIONS_URL,
    model: OLLAMA_MODEL,
    extractDir,
  });
  console.log("[DA][Ollama] System prompt\n" + systemPrompt);
  console.log("[DA][Ollama] User message\n" + userMessage);
  const result = await chooseLaunchFileFromTreeWithOllama(tree);
  const launchFiles = result.paths.map((relativeLaunchPath) => {
    const launchFilePath = path.resolve(extractDir, relativeLaunchPath);

    assertInside(extractDir, launchFilePath);

    if (
      !fs.existsSync(launchFilePath) ||
      !fs.statSync(launchFilePath).isFile()
    ) {
      throw new Error(`LLM selected a missing file: ${relativeLaunchPath}`);
    }

    return {
      relativeLaunchPath,
      launchFilePath,
    };
  });

  console.log("[DA][Ollama] Selected launch files", {
    launchFiles,
  });

  return launchFiles;
}

async function chooseLaunchFileWithOllama(extractDir) {
  const [launchFile] = await chooseLaunchFilesWithOllama(extractDir);

  return launchFile.launchFilePath;
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
    let workLaunchFiles = [
      {
        relativeLaunchPath: path.basename(workManagedSourcePath),
        launchFilePath: workManagedSourcePath,
      },
    ];

    if (extension === ".zip") {
      console.log("[DA] Extracting zip into managed temp work dir", {
        managedSourcePath: workManagedSourcePath,
        extractDir,
      });
      await extractZipSafely(workManagedSourcePath, extractDir);
      await extractNestedZipsInPlace(extractDir);
      workLaunchFiles = await chooseLaunchFilesWithOllama(extractDir);
    } else {
      console.log("[DA] Using downloaded file directly as launch file", {
        managedSourcePath: workManagedSourcePath,
        extension: extension || "[no extension]",
      });
    }

    await promotePreparedWorkDir(workDir, fileDir);

    const managedFilePath = rebasePreparedPath(
      workManagedSourcePath,
      workDir,
      fileDir,
    );
    const launchFilePaths = workLaunchFiles.map((launchFile) =>
      rebasePreparedPath(launchFile.launchFilePath, workDir, fileDir),
    );
    const launchFileUrls = launchFilePaths.map(pathToFileUrl);

    return {
      managedRoot,
      managedFilePath,
      launchFilePath: launchFilePaths[0],
      launchFilePaths,
      launchFileUrl: launchFileUrls[0],
      launchFileUrls,
      launchFileLabels: workLaunchFiles.map(
        (launchFile) => launchFile.relativeLaunchPath,
      ),
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
  const currentWork = activeDownloadAgentWork.get(jobKey);

  if (currentWork?.job) {
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
    if (activeDownloadAgentWork.get(jobKey)?.job === job) {
      activeDownloadAgentWork.delete(jobKey);
    }
  });

  setActiveDownloadAgentWork(file, currentWork?.phase || "unpacking", job);
}

async function runDownloadAgentPreparation(
  file,
  downloadedFilePath,
  managedRoot,
) {
  try {
    console.log("[DA] Server preparation started", {
      caseKey: file.caseKey,
      fileId: file.fileId,
      downloadedFilePath,
    });
    const prepared = await prepareDownloadedFile(file, downloadedFilePath);

    await updateFileState(file, prepared.managedRoot, (fileState) => {
      fileState.status = DA_STATUS.READY;
      fileState.phase = "ready";
      fileState.sourceFilePath = normalizeDownloadedPath(downloadedFilePath);
      fileState.managedFilePath = prepared.managedFilePath;
      fileState.launchFilePath = prepared.launchFilePath;
      fileState.launchFilePaths = prepared.launchFilePaths;
      fileState.launchFileUrl = prepared.launchFileUrl;
      fileState.launchFileUrls = prepared.launchFileUrls;
      fileState.launchFileLabels = prepared.launchFileLabels;
      fileState.error = null;
      fileState.updatedAt = nowIso();
    });

    console.log("[DA] File ready", {
      fileId: file.fileId,
      launchFilePath: prepared.launchFilePath,
      launchFilePaths: prepared.launchFilePaths,
      launchFileUrls: prepared.launchFileUrls,
    });
  } catch (error) {
    console.error("[DA] Preparation failed:", error);
    await updateFileState(file, managedRoot, (fileState) => {
      fileState.status = DA_STATUS.FAILED;
      fileState.phase = "failed";
      fileState.error = error.message;
      fileState.updatedAt = nowIso();
    });
  } finally {
    clearActiveDownloadAgentWork(file);
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
  return async (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    try {
      console.log("[DA] Job started", file);
      setActiveDownloadAgentWork(file, "downloading");
      const state = await updateFileState(file, null, (fileState) => {
        fileState.status = DA_STATUS.PREPARING;
        fileState.phase = "downloading";
        fileState.error = null;
        fileState.launchFilePath = null;
        fileState.launchFilePaths = null;
        fileState.launchFileUrl = null;
        fileState.launchFileUrls = null;
        fileState.launchFileLabels = null;
        fileState.updatedAt = nowIso();
      });

      res.json(stateForResponse(state));
    } catch (error) {
      clearActiveDownloadAgentWork(file);
      console.error("[DA] Failed to start job:", error);
      res.status(500).json({ error: error.message });
    }
  };
}

function createDownloadAgentCompleteHandler() {
  return async (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    const { downloadedFilePath } = req.body || {};
    const sourceFilePath = normalizeDownloadedPath(downloadedFilePath);
    const managedRoot = getManagedTempRoot(sourceFilePath || "");

    try {
      setActiveDownloadAgentWork(file, "unpacking");
      const state = await updateFileState(file, managedRoot, (fileState) => {
        fileState.status = DA_STATUS.PREPARING;
        fileState.phase = "unpacking";
        fileState.error = null;
        fileState.launchFilePath = null;
        fileState.launchFilePaths = null;
        fileState.launchFileUrl = null;
        fileState.launchFileUrls = null;
        fileState.launchFileLabels = null;
        fileState.updatedAt = nowIso();
      });

      console.log("[DA] Browser download completed; preparation queued", {
        caseKey: file.caseKey,
        fileId: file.fileId,
        downloadedFilePath,
      });
      queueDownloadAgentPreparation(file, downloadedFilePath, managedRoot);

      res.json(stateForResponse(state));
    } catch (error) {
      clearActiveDownloadAgentWork(file);
      console.error("[DA] Failed to complete browser download:", error);
      res.status(500).json({ error: error.message });
    }
  };
}

function createDownloadAgentFailHandler() {
  return async (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    try {
      clearActiveDownloadAgentWork(file);
      console.log("[DA] Browser download failed", {
        caseKey: file.caseKey,
        fileId: file.fileId,
        error: req.body?.error,
      });

      const state = await updateFileState(file, null, (fileState) => {
        fileState.status = DA_STATUS.FAILED;
        fileState.phase = "failed";
        fileState.error =
          typeof req.body?.error === "string" && req.body.error.trim() !== ""
            ? req.body.error.trim()
            : "Browser download failed";
        fileState.updatedAt = nowIso();
      });

      res.json(stateForResponse(state));
    } catch (error) {
      console.error("[DA] Failed to mark browser download failed:", error);
      res.status(500).json({ error: error.message });
    }
  };
}

function createDownloadAgentOpenHandler() {
  return async (req, res) => {
    const file = validateCaseAndFile(req, res);

    if (!file) {
      return;
    }

    const launchFileIndex =
      Number.isInteger(req.body?.launchFileIndex) &&
      req.body.launchFileIndex >= 0
        ? req.body.launchFileIndex
        : 0;

    try {
      const readyFile = await updateCaseState(file.caseKey, null, (state) => {
        refreshCaseStateFromDisk(state);
        const fileState = state.files[file.fileId];

        if (!fileState || fileState.status !== DA_STATUS.READY) {
          return null;
        }

        const launchFilePaths = getFileStateLaunchFilePaths(fileState);

        if (launchFileIndex >= launchFilePaths.length) {
          return {
            error: `Launch file option ${launchFileIndex + 1} is not available`,
          };
        }

        return {
          launchFilePath: launchFilePaths[launchFileIndex],
        };
      });

      if (!readyFile) {
        res.status(409).json({ error: "File is not ready to view" });
        return;
      }

      if (readyFile.error) {
        res.status(400).json({ error: readyFile.error });
        return;
      }

      try {
        await launchFileWithInvivoDental(readyFile.launchFilePath);
        res.json({ ok: true });
      } catch (error) {
        console.error("[DA] Open failed:", error);

        if (error.message === "Prepared launch file is missing") {
          await updateCaseState(file.caseKey, null, (state) => {
            const fileState = state.files[file.fileId];
            const launchFilePaths = fileState
              ? getFileStateLaunchFilePaths(fileState)
              : [];

            if (launchFilePaths.includes(readyFile.launchFilePath)) {
              delete state.files[file.fileId];
            }
          });
        }

        res.status(500).json({ error: error.message });
      }
    } catch (error) {
      console.error("[DA] Open state update failed:", error);
      res.status(500).json({ error: error.message });
    }
  };
}

function createDownloadAgentStateHandler() {
  return async (req, res) => {
    const caseKey = req.query.caseKey;

    if (typeof caseKey !== "string" || caseKey.trim() === "") {
      res.status(400).json({ error: "caseKey is required" });
      return;
    }

    try {
      const state = await updateCaseState(caseKey.trim(), null, (state) => {
        refreshCaseStateFromDisk(state);
      });

      res.json(stateForResponse(state));
    } catch (error) {
      console.error("[DA] Failed to read state:", error);
      res.status(500).json({ error: error.message });
    }
  };
}

function createDownloadAgentTempClearHandler() {
  return async (req, res) => {
    try {
      const deletedRoots = await deleteDownloadAgentTempRoots();

      res.json({ ok: true, deletedRoots });
    } catch (error) {
      console.error("[DA] Failed to delete temp directory:", error);
      res.status(500).json({ error: error.message });
    }
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
  app.post("/download-agent/temp/clear", createDownloadAgentTempClearHandler());
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
  buildLaunchFileSelectionTree,
  chooseLaunchFileFromTreeWithOllama,
  chooseLaunchFilesWithOllama,
  createApp,
  createLaunchFileSelectionMessages,
  createLaunchFileSelectionRequest,
  formatLaunchFileSelectionJson,
  listTemplates,
  normalizeLaunchFileSelectionResult,
  parseStrictJsonObject,
  renderDocument,
  requestOllamaCompletionText,
  resolveTemplatePath,
};
