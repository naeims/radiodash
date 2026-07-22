const SERVER_BASE_URL = "http://localhost:5000";
const DOWNLOAD_STORAGE_PREFIX = "downloadAgentDownload:";
const PORTAL_CLICK_PENDING_KEY = "downloadAgentPendingPortalClicks";
const AUTO_PREPARE_ENABLED_KEY = "downloadAgentAutoPrepareEnabled";
const SHOW_TOOLTIPS_ENABLED_KEY = "downloadAgentShowTooltipsEnabled";
const PORTAL_CLICK_TIMEOUT_MS = 60000;
const AUTO_PREPARE_DEBOUNCE_MS = 1000;

const portalClickTimeouts = new Map();
const autoPrepareTimers = new Map();
const autoPrepareFileKeys = new Set();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    generate_document: () => handleGenerateDocument(request),
    get_download_agent_files: () => getDownloadAgentFiles(),
    prepare_download_agent_file: () => prepareDownloadAgentFile(request.file),
    view_download_agent_file: () =>
      viewDownloadAgentFile(request.file, request.launchFileIndex),
    get_auto_prepare_setting: () => getAutoPrepareSetting(),
    set_auto_prepare_setting: () => setAutoPrepareSetting(request.enabled),
    get_tooltips_setting: () => getTooltipsSetting(),
    set_tooltips_setting: () => setTooltipsSetting(request.enabled),
    delete_download_agent_temp: () => deleteDownloadAgentTemp(),
  };
  const handler = handlers[request.action];

  if (!handler) {
    return false;
  }

  handler()
    .then(sendResponse)
    .catch((error) => {
      console.error(`[DA] Failed to handle ${request.action}:`, error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) {
    return;
  }

  scheduleAutoPrepareForTab(tabId, changeInfo.url || tab.url);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) {
      return;
    }

    scheduleAutoPrepareForTab(tabId, tab.url);
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state?.current) {
    return;
  }

  handleDownloadStateChanged(delta).catch((error) => {
    console.error("[DA] Download state handler failed:", error);
  });
});

chrome.downloads.onCreated.addListener((downloadItem) => {
  handleDownloadCreated(downloadItem).catch((error) => {
    console.error("[DA] Download created handler failed:", error);
  });
});

async function handleGenerateDocument(request) {
  console.log(
    "Received generate_document action with template:",
    request.template,
  );
  const activeTab = await getActiveTab();

  if (!activeTab?.id || !activeTab?.url) {
    throw new Error("No active tab found");
  }

  console.log("Active tab URL:", activeTab.url);
  const results = await executeScript(activeTab.id, collectAndSendData, [
    activeTab.url,
    request.template,
    SERVER_BASE_URL,
  ]);

  console.log("Script injected successfully:", results);
  return { ok: true };
}

async function getDownloadAgentFiles() {
  const activeTab = await getActiveTab();

  if (!activeTab?.id || !activeTab?.url) {
    throw new Error("No active tab found");
  }

  const payload = await inspectDownloadAgentFilesInTab(
    activeTab.id,
    activeTab.url,
  );

  return {
    ok: true,
    ...payload,
  };
}

async function inspectDownloadAgentFilesInTab(tabId, tabUrl) {
  console.log("[DA] Inspecting tab for download links:", tabUrl);
  const results = await executeScript(tabId, collectDownloadAgentLinks, [
    tabUrl,
  ]);
  const payload = results?.[0]?.result;

  if (!payload?.caseKey) {
    throw new Error("Could not determine case from tab URL");
  }

  const serverState = await getJson(
    `/download-agent/state?caseKey=${encodeURIComponent(payload.caseKey)}`,
  );
  const serverFilesByName = buildUniqueServerFilesByName(serverState.files);
  const files = payload.files
    .map((file) => {
      const exactState = serverState.files?.[file.fileId] || null;
      const fallbackState = exactState
        ? null
        : serverFilesByName.get(file.fileName) || null;
      const state = exactState || fallbackState || {};

      if (fallbackState) {
        console.log("[DA] Matched portal row to server state by file name", {
          fileName: file.fileName,
          portalFileId: file.fileId,
          stateFileId: fallbackState.fileId,
        });
      }

      return {
        ...file,
        fileId: state.fileId || file.fileId,
        status: state.status || "not_downloaded",
        phase: state.phase || null,
        error: state.error || null,
        launchFileUrl: state.launchFileUrl || null,
        launchFileUrls: Array.isArray(state.launchFileUrls)
          ? state.launchFileUrls
          : [],
        launchFiles: Array.isArray(state.launchFiles) ? state.launchFiles : [],
        updatedAt: state.updatedAt || null,
      };
    })
    .filter((file) => file.canPrepare || file.status !== "not_downloaded");

  console.log("[DA] Found portal download files:", files);

  return {
    caseKey: payload.caseKey,
    files,
  };
}

function buildUniqueServerFilesByName(serverFiles) {
  const filesByName = new Map();
  const duplicateNames = new Set();

  Object.values(serverFiles || {}).forEach((fileState) => {
    if (!fileState?.fileName) {
      return;
    }

    if (filesByName.has(fileState.fileName)) {
      duplicateNames.add(fileState.fileName);
      return;
    }

    filesByName.set(fileState.fileName, fileState);
  });

  duplicateNames.forEach((fileName) => filesByName.delete(fileName));

  if (duplicateNames.size > 0) {
    console.log("[DA] Skipping ambiguous file-name state matches", {
      duplicateNames: Array.from(duplicateNames),
    });
  }

  return filesByName;
}

async function prepareDownloadAgentFile(file, tabId = null) {
  if (!file?.caseKey || !file?.fileId) {
    throw new Error("Invalid Download Agent file payload");
  }

  if (!file.downloadUrl) {
    return preparePortalClickDownloadAgentFile(file, tabId);
  }

  console.log("[DA] Starting browser download:", file);
  await postJson("/download-agent/jobs", file);

  const downloadId = await downloadFile(file.downloadUrl);

  await storageSet(downloadStorageKey(downloadId), file);

  console.log("[DA] Browser download started", {
    downloadId,
    fileName: file.fileName,
  });

  const [downloadItem] = await searchDownloads({ id: downloadId });
  if (
    downloadItem?.state === "complete" ||
    downloadItem?.state === "interrupted"
  ) {
    handleDownloadStateChanged({
      id: downloadId,
      state: { current: downloadItem.state },
      error: downloadItem.error ? { current: downloadItem.error } : null,
    }).catch((error) => {
      console.error("[DA] Immediate download state handler failed:", error);
    });
  }

  return {
    ok: true,
    downloadId,
  };
}

async function preparePortalClickDownloadAgentFile(file, tabId = null) {
  const targetTabId = tabId || (await getActiveTab())?.id;

  if (!targetTabId) {
    throw new Error("No target tab found");
  }

  console.log("[DA] Starting portal-click browser download:", file);
  await postJson("/download-agent/jobs", file);

  const pending = await registerPendingPortalClick(file, targetTabId);

  try {
    const results = await executeScript(
      targetTabId,
      clickPortalDownloadButton,
      [
        {
          buttonIndex: file.buttonIndex,
          fileName: file.fileName,
        },
      ],
    );
    const payload = results?.[0]?.result;

    if (!payload?.ok) {
      throw new Error(
        payload?.error || "Portal download button was not clicked",
      );
    }

    console.log("[DA] Portal download button clicked", {
      fileName: file.fileName,
      buttonIndex: file.buttonIndex,
      token: pending.token,
    });
  } catch (error) {
    await removePendingPortalClick(pending.token);
    await postJson("/download-agent/fail", {
      ...file,
      error: error.message,
    });
    throw error;
  }

  return {
    ok: true,
    downloadPending: true,
  };
}

function scheduleAutoPrepareForTab(tabId, tabUrl) {
  if (!isLikelyCaseUrl(tabUrl)) {
    return;
  }

  if (autoPrepareTimers.has(tabId)) {
    clearTimeout(autoPrepareTimers.get(tabId));
  }

  autoPrepareTimers.set(
    tabId,
    setTimeout(() => {
      autoPrepareTimers.delete(tabId);
      autoPrepareDownloadAgentFilesInTab(tabId, tabUrl).catch((error) => {
        console.log("[DA] Automatic prepare skipped or failed:", {
          tabUrl,
          error: error.message,
        });
      });
    }, AUTO_PREPARE_DEBOUNCE_MS),
  );
}

function isLikelyCaseUrl(tabUrl) {
  if (typeof tabUrl !== "string" || tabUrl.trim() === "") {
    return false;
  }

  try {
    const url = new URL(tabUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    const parts = url.pathname.split("/").filter(Boolean);

    return parts.includes("patients") && parts.includes("radiology");
  } catch {
    return false;
  }
}

async function autoPrepareDownloadAgentFilesInTab(tabId, tabUrl) {
  if (!(await getAutoPrepareEnabled())) {
    console.log("[DA] Automatic prepare disabled");
    return;
  }

  const payload = await inspectDownloadAgentFilesInTab(tabId, tabUrl);
  const firstFile = payload.files[0];

  if (!firstFile) {
    console.log("[DA] Automatic prepare found no files", {
      caseKey: payload.caseKey,
    });
    return;
  }

  if (!firstFile.canPrepare || firstFile.status !== "not_downloaded") {
    console.log("[DA] Automatic prepare found no eligible first file", {
      caseKey: payload.caseKey,
      fileId: firstFile.fileId,
      fileName: firstFile.fileName,
      status: firstFile.status,
      canPrepare: firstFile.canPrepare,
    });
    return;
  }

  console.log("[DA] Automatic prepare starting", {
    caseKey: payload.caseKey,
    fileId: firstFile.fileId,
    fileName: firstFile.fileName,
  });

  const fileKey = `${firstFile.caseKey}\n${firstFile.fileId}`;

  if (autoPrepareFileKeys.has(fileKey)) {
    return;
  }

  autoPrepareFileKeys.add(fileKey);

  try {
    await prepareDownloadAgentFile(firstFile, tabId);
    notifyDownloadAgentStateUpdated(firstFile.caseKey);
  } catch (error) {
    console.error("[DA] Automatic prepare failed:", {
      caseKey: firstFile.caseKey,
      fileId: firstFile.fileId,
      fileName: firstFile.fileName,
      error: error.message,
    });
  } finally {
    autoPrepareFileKeys.delete(fileKey);
  }
}

async function getAutoPrepareSetting() {
  return {
    ok: true,
    enabled: await getAutoPrepareEnabled(),
  };
}

async function setAutoPrepareSetting(enabled) {
  await storageSet(AUTO_PREPARE_ENABLED_KEY, enabled !== false);

  return {
    ok: true,
    enabled: await getAutoPrepareEnabled(),
  };
}

async function getAutoPrepareEnabled() {
  const enabled = await storageGet(AUTO_PREPARE_ENABLED_KEY);

  return enabled !== false;
}

async function getTooltipsSetting() {
  return {
    ok: true,
    enabled: await getTooltipsEnabled(),
  };
}

async function setTooltipsSetting(enabled) {
  await storageSet(SHOW_TOOLTIPS_ENABLED_KEY, enabled !== false);

  return {
    ok: true,
    enabled: await getTooltipsEnabled(),
  };
}

async function getTooltipsEnabled() {
  const enabled = await storageGet(SHOW_TOOLTIPS_ENABLED_KEY);

  return enabled !== false;
}

async function viewDownloadAgentFile(file, launchFileIndex = 0) {
  if (!file?.caseKey || !file?.fileId) {
    throw new Error("Invalid Download Agent file payload");
  }

  console.log("[DA] Requesting OS open for prepared file", {
    caseKey: file.caseKey,
    fileId: file.fileId,
    fileName: file.fileName,
  });

  return {
    ok: true,
    ...(await postJson("/download-agent/open", {
      ...file,
      launchFileIndex,
    })),
  };
}

async function handleDownloadStateChanged(delta) {
  const key = downloadStorageKey(delta.id);
  const file = await storageGet(key);

  if (!file) {
    return;
  }

  if (delta.state.current === "interrupted") {
    const error = delta.error?.current || "Browser download interrupted";
    console.error("[DA] Browser download interrupted", { file, error });
    await postJson("/download-agent/fail", { ...file, error });
    await storageRemove(key);
    notifyDownloadAgentStateUpdated(file.caseKey);
    return;
  }

  if (delta.state.current !== "complete") {
    return;
  }

  const [downloadItem] = await searchDownloads({ id: delta.id });

  if (!downloadItem?.filename) {
    await postJson("/download-agent/fail", {
      ...file,
      error: "Chrome did not provide a completed download path",
    });
    await storageRemove(key);
    notifyDownloadAgentStateUpdated(file.caseKey);
    return;
  }

  console.log("[DA] Browser download complete", {
    downloadId: delta.id,
    filename: downloadItem.filename,
  });

  try {
    await postJson("/download-agent/complete", {
      ...file,
      downloadedFilePath: downloadItem.filename,
    });
  } catch (error) {
    console.error("[DA] Server preparation failed:", error);
  } finally {
    await storageRemove(key);
    notifyDownloadAgentStateUpdated(file.caseKey);
  }
}

async function handleDownloadCreated(downloadItem) {
  const pending = await claimPendingPortalClick(downloadItem);

  if (!pending) {
    return;
  }

  await storageSet(downloadStorageKey(downloadItem.id), pending.file);

  console.log("[DA] Associated portal-click download with DA file", {
    downloadId: downloadItem.id,
    fileName: pending.file.fileName,
    downloadUrl: downloadItem.url,
  });

  if (
    downloadItem.state === "complete" ||
    downloadItem.state === "interrupted"
  ) {
    await handleDownloadStateChanged({
      id: downloadItem.id,
      state: { current: downloadItem.state },
      error: downloadItem.error ? { current: downloadItem.error } : null,
    });
  }
}

function notifyDownloadAgentStateUpdated(caseKey) {
  chrome.runtime.sendMessage(
    { action: "download_agent_state_updated", caseKey },
    () => {
      if (chrome.runtime.lastError) {
        console.log("[DA] No popup listener for state update");
      }
    },
  );
}

function collectDownloadAgentLinks(pageUrl) {
  const url = new URL(pageUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const patientIndex = parts.indexOf("patients");
  const radiologyIndex = parts.indexOf("radiology");
  const pid =
    patientIndex !== -1 && parts[patientIndex + 1]
      ? parts[patientIndex + 1]
      : "unknown-patient";
  const sid =
    radiologyIndex !== -1 && parts[radiologyIndex + 1]
      ? parts[radiologyIndex + 1]
      : "unknown-study";
  const caseKey = `patients/${pid}/radiology/${sid}`;

  function simpleHash(value) {
    let hash = 0;

    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }

    return Math.abs(hash).toString(36);
  }

  const buttons = Array.from(
    document.querySelectorAll(".report-detail-download-btn"),
  );
  const rowCandidates = Array.from(
    document.querySelectorAll(".recent-files-list .k-hbox, .file-name-trunc"),
  );
  const rows = Array.from(
    new Set(
      rowCandidates
        .map((element) =>
          element.matches(".file-name-trunc")
            ? element.closest(".k-hbox") || element.parentElement
            : element,
        )
        .filter((row) => row?.querySelector(".file-name-trunc")),
    ),
  );

  const files = rows.map((row, index) => {
    const button = row.querySelector(".report-detail-download-btn");
    const nameElement = row?.querySelector(".file-name-trunc");
    const fileName =
      nameElement?.getAttribute("title")?.trim() ||
      nameElement?.textContent?.trim() ||
      button?.getAttribute("title")?.trim() ||
      `Download ${index + 1}`;
    const rawDownloadUrl =
      button?.dataset.downloadUrl ||
      button?.getAttribute("data-download-url") ||
      button?.getAttribute("href");
    const downloadUrl = rawDownloadUrl
      ? new URL(rawDownloadUrl, url.href).href
      : "";
    const buttonIndex = button ? buttons.indexOf(button) : -1;
    const downloadIdentity = downloadUrl || `portal-click:${index}:${fileName}`;
    const fileId = `${caseKey}/${simpleHash(`${downloadIdentity}|${fileName}`)}`;

    return {
      caseKey,
      fileId,
      fileName,
      downloadUrl,
      downloadAction: downloadUrl
        ? "direct_url"
        : button
          ? "portal_click"
          : "unavailable",
      canPrepare: Boolean(downloadUrl || button),
      buttonIndex,
    };
  });

  console.log("[DA] Portal download row scan", {
    rowCount: rows.length,
    buttonCount: buttons.length,
    fileCount: files.length,
    files,
  });

  return {
    caseKey,
    files,
  };
}

function clickPortalDownloadButton(target) {
  const buttons = Array.from(
    document.querySelectorAll(".report-detail-download-btn"),
  );
  const getButtonFileName = (button) => {
    const row = button.closest(".k-hbox") || button.parentElement;
    const nameElement = row?.querySelector(".file-name-trunc");

    return (
      nameElement?.getAttribute("title")?.trim() ||
      nameElement?.textContent?.trim() ||
      ""
    );
  };
  const indexedButton =
    Number.isInteger(target?.buttonIndex) && target.buttonIndex >= 0
      ? buttons[target.buttonIndex]
      : null;
  const byIndex =
    indexedButton &&
    (!target?.fileName || getButtonFileName(indexedButton) === target.fileName)
      ? indexedButton
      : null;
  const byName = buttons.find((button) => {
    return getButtonFileName(button) === target?.fileName;
  });
  const button = byIndex || byName;

  if (!button) {
    return {
      ok: false,
      error: "Portal download button could not be found",
    };
  }

  if (button.disabled || button.getAttribute("aria-disabled") === "true") {
    return {
      ok: false,
      error: "Portal download button is disabled",
    };
  }

  button.click();

  return {
    ok: true,
  };
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

function executeScript(tabId, func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        function: func,
        args,
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(results);
      },
    );
  });
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        saveAs: false,
        conflictAction: "uniquify",
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(downloadId);
      },
    );
  });
}

function searchDownloads(query) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search(query, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(items);
    });
  });
}

function downloadStorageKey(downloadId) {
  return `${DOWNLOAD_STORAGE_PREFIX}${downloadId}`;
}

async function registerPendingPortalClick(file, tabId) {
  const pending = {
    token: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    tabId,
    file,
  };
  const pendingClicks = await getPendingPortalClicks();

  await setPendingPortalClicks([...pendingClicks, pending]);
  schedulePortalClickTimeout(pending);

  return pending;
}

async function claimPendingPortalClick(downloadItem) {
  const pendingClicks = await getPendingPortalClicks();
  const now = Date.now();
  const activePendingClicks = pendingClicks.filter(
    (pending) => now - pending.createdAt <= PORTAL_CLICK_TIMEOUT_MS,
  );

  if (activePendingClicks.length !== pendingClicks.length) {
    await setPendingPortalClicks(activePendingClicks);
  }

  if (activePendingClicks.length === 0) {
    return null;
  }

  const fileNameMatchIndex = activePendingClicks.findIndex((pending) =>
    downloadItem.filename?.endsWith(pending.file.fileName),
  );
  const pendingIndex = fileNameMatchIndex === -1 ? 0 : fileNameMatchIndex;
  const [pending] = activePendingClicks.splice(pendingIndex, 1);

  await setPendingPortalClicks(activePendingClicks);
  clearPortalClickTimeout(pending.token);

  return pending;
}

async function removePendingPortalClick(token) {
  const pendingClicks = await getPendingPortalClicks();

  await setPendingPortalClicks(
    pendingClicks.filter((pending) => pending.token !== token),
  );
  clearPortalClickTimeout(token);
}

async function getPendingPortalClicks() {
  const pendingClicks = await storageGet(PORTAL_CLICK_PENDING_KEY);

  return Array.isArray(pendingClicks) ? pendingClicks : [];
}

function setPendingPortalClicks(pendingClicks) {
  return storageSet(PORTAL_CLICK_PENDING_KEY, pendingClicks);
}

function schedulePortalClickTimeout(pending) {
  clearPortalClickTimeout(pending.token);

  const timeoutId = setTimeout(() => {
    handlePortalClickTimeout(pending).catch((error) => {
      console.error("[DA] Portal-click timeout handler failed:", error);
    });
  }, PORTAL_CLICK_TIMEOUT_MS);

  portalClickTimeouts.set(pending.token, timeoutId);
}

function clearPortalClickTimeout(token) {
  const timeoutId = portalClickTimeouts.get(token);

  if (timeoutId) {
    clearTimeout(timeoutId);
    portalClickTimeouts.delete(token);
  }
}

async function handlePortalClickTimeout(pending) {
  await removePendingPortalClick(pending.token);
  await postJson("/download-agent/fail", {
    ...pending.file,
    error: "Portal download did not start within 60 seconds",
  });
  notifyDownloadAgentStateUpdated(pending.file.caseKey);
}

async function deleteDownloadAgentTemp() {
  return {
    ok: true,
    ...(await postJson("/download-agent/temp/clear", {})),
  };
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (items) => {
      resolve(
        Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null,
      );
    });
  });
}

function storageRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, resolve);
  });
}

async function getJson(pathAndQuery) {
  const response = await fetch(`${SERVER_BASE_URL}${pathAndQuery}`);

  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}`);
  }

  return response.json();
}

async function postJson(pathAndQuery, body) {
  const response = await fetch(`${SERVER_BASE_URL}${pathAndQuery}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Server returned HTTP ${response.status}`);
  }

  return payload;
}

async function collectAndSendData(pageUrl, template, serverBaseUrl) {
  console.log("collectData function called with URL:", pageUrl);

  function extractData(pageUrl) {
    const urlParts = pageUrl.split("/");

    const getPathValueAfter = (segment) => {
      const segmentIndex = urlParts.indexOf(segment);
      if (segmentIndex === -1 || !urlParts[segmentIndex + 1]) {
        return "N/A";
      }

      return urlParts[segmentIndex + 1].replace(/\B(?=(\d{3})+(?!\d))/g, "");
    };

    const pid = getPathValueAfter("patients");
    const sid = getPathValueAfter("radiology");

    console.log("Parsed PID:", pid);
    console.log("Parsed SID:", sid);

    const getLabeledValue = (labelText, valueClass) => {
      const label = Array.from(
        document.querySelectorAll("div.detail-label"),
      ).find((div) => div.textContent.trim() === labelText);
      const valueElement = label?.nextElementSibling;

      return valueElement?.classList.contains(valueClass)
        ? valueElement.textContent.trim()
        : "N/A";
    };

    const getPatientName = () => {
      const nameDiv = document.querySelector(
        "div.patient-profile-image-name div.f-size-24",
      );
      return nameDiv ? nameDiv.textContent.trim() : "N/A";
    };

    const getStudyPurpose = () => {
      const studyPurposeLabel = Array.from(
        document.querySelectorAll("div.col-5 span.k-card-subtitle"),
      ).find((span) => span.textContent.trim() === "Study purpose:");

      if (studyPurposeLabel) {
        const studyPurposeValue = studyPurposeLabel
          .closest("div.row")
          .querySelector("div.col-7 span.ng-star-inserted");
        return studyPurposeValue ? studyPurposeValue.textContent.trim() : "N/A";
      }

      return "N/A";
    };

    const getClinicalNotes = () => {
      const clinicalNotesLabel = Array.from(
        document.querySelectorAll("h3.font-weight-normal"),
      ).find((h3) => h3.textContent.trim() === "Doctor's Notes");

      if (clinicalNotesLabel) {
        const textarea = clinicalNotesLabel
          .closest("div.col-6")
          .querySelector("textarea.k-input-inner");
        return textarea ? textarea.value.trim() : "N/A";
      }

      return "N/A";
    };

    const formatReportDate = () => {
      const now = new Date();
      const day = String(now.getDate());
      const month = String(now.getMonth() + 1);
      const year = now.getFullYear();
      return `${month}/${day}/${year}`;
    };

    const formatUTCTime = () => {
      const now = new Date();
      const day = String(now.getUTCDate()).padStart(2, "0");
      const month = String(now.getUTCMonth() + 1).padStart(2, "0");
      const year = String(now.getUTCFullYear()).slice(2);
      const hours = String(now.getUTCHours()).padStart(2, "0");
      const minutes = String(now.getUTCMinutes()).padStart(2, "0");
      const seconds = String(now.getUTCSeconds()).padStart(2, "0");
      const milliseconds = String(now.getUTCMilliseconds()).padStart(3, "0");
      return `${month}${day}${year}${hours}${minutes}${seconds}${milliseconds}`;
    };

    const utcTime = formatUTCTime();

    return {
      page_url: pageUrl,
      pid,
      sid,
      patient_name: getPatientName(),
      patient_dob: getLabeledValue("DOB:", "detail-value"),
      patient_age: getLabeledValue("Age:", "detail-value"),
      patient_gender: getLabeledValue("Sex:", "detail-value"),
      study_purpose: getStudyPurpose(),
      clinical_notes: getClinicalNotes(),
      report_date: formatReportDate(),
      scan_date: "!",
      requesting_doctor: getLabeledValue("Primary Dentist:", "k-link"),
      submitting_group: getLabeledValue("Practice Name:", "k-link"),
      utc_time: utcTime,
    };
  }

  const data = extractData(pageUrl);
  console.log("Collected data:", data);

  const patientNameForFile = data.patient_name.replace(/\s+/g, "_");
  const fileName = `RadReport_${patientNameForFile}_${data.utc_time}_MA.docx`;

  const response = await fetch(`${serverBaseUrl}/generate_document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ template, data }),
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);

  return { ok: true };
}
