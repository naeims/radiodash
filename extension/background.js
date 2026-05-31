const SERVER_BASE_URL = "http://localhost:5000";
const DOWNLOAD_STORAGE_PREFIX = "downloadAgentDownload:";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "generate_document") {
    handleGenerateDocument(request, sendResponse);
    return true;
  }

  if (request.action === "get_download_agent_files") {
    getDownloadAgentFiles()
      .then(sendResponse)
      .catch((error) => {
        console.error("[DA] Failed to get files:", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (request.action === "prepare_download_agent_file") {
    prepareDownloadAgentFile(request.file)
      .then(sendResponse)
      .catch((error) => {
        console.error("[DA] Failed to prepare file:", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (request.action === "view_download_agent_file") {
    viewDownloadAgentFile(request.file)
      .then(sendResponse)
      .catch((error) => {
        console.error("[DA] Failed to open prepared file:", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state?.current) {
    return;
  }

  handleDownloadStateChanged(delta).catch((error) => {
    console.error("[DA] Download state handler failed:", error);
  });
});

function handleGenerateDocument(request, sendResponse) {
  console.log(
    "Received generate_document action with template:",
    request.template,
  );
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      let activeTab = tabs[0];
      let activeTabId = activeTab.id;
      let activeTabUrl = activeTab.url;

      console.log("Active tab URL:", activeTabUrl);
      chrome.scripting.executeScript(
        {
          target: { tabId: activeTabId },
          function: collectAndSendData,
          args: [activeTabUrl, request.template],
        },
        (results) => {
          if (chrome.runtime.lastError) {
            console.error("Script injection error:", chrome.runtime.lastError);
            sendResponse({
              ok: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            console.log("Script injected successfully:", results);
            sendResponse({ ok: true });
          }
        },
      );
    } else {
      console.error("No active tab found");
      sendResponse({ ok: false, error: "No active tab found" });
    }
  });
}

async function getDownloadAgentFiles() {
  const activeTab = await getActiveTab();

  if (!activeTab?.id || !activeTab?.url) {
    throw new Error("No active tab found");
  }

  console.log("[DA] Inspecting active tab for download links:", activeTab.url);
  const results = await executeScript(activeTab.id, collectDownloadAgentLinks, [
    activeTab.url,
  ]);
  const payload = results?.[0]?.result;

  if (!payload?.caseKey) {
    throw new Error("Could not determine case from active tab URL");
  }

  const serverState = await getJson(
    `/download-agent/state?caseKey=${encodeURIComponent(payload.caseKey)}`,
  );
  const files = payload.files.map((file) => {
    const state = serverState.files?.[file.fileId] || {};

    return {
      ...file,
      status: state.status || "not_downloaded",
      error: state.error || null,
      launchFileUrl: state.launchFileUrl || null,
      updatedAt: state.updatedAt || null,
    };
  });

  console.log("[DA] Found portal download files:", files);

  return {
    ok: true,
    caseKey: payload.caseKey,
    files,
  };
}

async function prepareDownloadAgentFile(file) {
  if (!file?.caseKey || !file?.fileId || !file?.downloadUrl) {
    throw new Error("Invalid Download Agent file payload");
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

async function viewDownloadAgentFile(file) {
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
    ...(await postJson("/download-agent/open", file)),
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

  const files = Array.from(
    document.querySelectorAll(".report-detail-download-btn[data-download-url]"),
  ).map((button, index) => {
    const row = button.closest(".k-hbox") || button.parentElement;
    const nameElement = row?.querySelector(".file-name-trunc");
    const fileName =
      nameElement?.getAttribute("title")?.trim() ||
      nameElement?.textContent?.trim() ||
      button.getAttribute("title")?.trim() ||
      `Download ${index + 1}`;
    const downloadUrl = new URL(button.dataset.downloadUrl, url.href).href;
    const fileId = `${caseKey}/${simpleHash(`${downloadUrl}|${fileName}`)}`;

    return {
      caseKey,
      fileId,
      fileName,
      downloadUrl,
    };
  });

  return {
    caseKey,
    files,
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

function storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (items) => resolve(items[key] || null));
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

function collectAndSendData(pageUrl, template) {
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

    const getDetailValue = (labelText) => {
      const detailLabel = Array.from(
        document.querySelectorAll("div.detail-label"),
      ).find((div) => div.textContent.trim() === labelText);
      if (detailLabel) {
        const detailValue = detailLabel.nextElementSibling;
        if (detailValue && detailValue.classList.contains("detail-value")) {
          return detailValue.textContent.trim();
        }
      }
      return "N/A";
    };

    const getLinkValue = (labelText) => {
      const label = Array.from(
        document.querySelectorAll("div.detail-label"),
      ).find((div) => div.textContent.trim() === labelText);
      if (label) {
        const valueElement = label.nextElementSibling;
        if (valueElement && valueElement.classList.contains("k-link")) {
          return valueElement.textContent.trim();
        }
      }
      return "N/A";
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
      pid: pid,
      sid: sid,
      patient_name: getPatientName(),
      patient_dob: getDetailValue("DOB:"),
      patient_age: getDetailValue("Age:"),
      patient_gender: getDetailValue("Sex:"),
      study_purpose: getStudyPurpose(),
      clinical_notes: getClinicalNotes(),
      report_date: formatReportDate(),
      scan_date: "!",
      requesting_doctor: getLinkValue("Primary Dentist:"),
      submitting_group: getLinkValue("Practice Name:"),
      utc_time: utcTime,
    };
  }

  const data = extractData(pageUrl);
  console.log("Collected data:", data);

  const patientNameForFile = data.patient_name.replace(/\s+/g, "_");
  const fileName = `RadReport_${patientNameForFile}_${data.utc_time}_MA.docx`;

  fetch("http://localhost:5000/generate_document", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ template, data }),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      return response.blob();
    })
    .then((blob) => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    })
    .catch((error) => {
      console.error("Error:", error);
    });
}
