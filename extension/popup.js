const SERVER_BASE_URL = "http://localhost:5000";
const DOWNLOAD_AGENT_POLL_INTERVAL_MS = 2000;

let currentDownloadAgentPayload = null;
let downloadAgentPollTimer = null;
let latestDownloadAgentLoadId = 0;

document.addEventListener("DOMContentLoaded", () => {
  loadTemplates();
  loadDownloadAgentFiles();

  document
    .getElementById("download-agent-refresh")
    .addEventListener("click", () => {
      console.log("[DA] Manual refresh requested");
      loadDownloadAgentFiles();
    });

  document
    .getElementById("download-agent-settings")
    .addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });

  chrome.runtime.onMessage.addListener((message) => {
    if (
      message.action === "download_agent_state_updated" &&
      currentDownloadAgentPayload?.caseKey === message.caseKey
    ) {
      console.log("[DA] Refreshing popup after background state update");
      loadDownloadAgentFiles();
    }
  });
});

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

async function loadTemplates() {
  try {
    const response = await fetch(`${SERVER_BASE_URL}/templates`);
    const templates = await response.json();
    const templateButtons = document.getElementById("template-buttons");

    templateButtons.textContent = "";
    templates.forEach((template) => {
      const button = document.createElement("button");

      button.textContent = template;
      button.addEventListener("click", async () => {
        try {
          const response = await sendRuntimeMessage({
            action: "generate_document",
            template,
          });

          console.log("Response from background:", response);
        } catch (error) {
          console.error("Error generating document:", error);
        }
      });
      templateButtons.appendChild(button);
    });
  } catch (error) {
    console.error("Error fetching templates:", error);
  }
}

async function loadDownloadAgentFiles(options = {}) {
  const { showLoading = true } = options;
  const loadId = ++latestDownloadAgentLoadId;

  if (showLoading) {
    setDownloadAgentStatus("Loading");
  }

  try {
    const payload = await sendRuntimeMessage({
      action: "get_download_agent_files",
    });

    if (loadId !== latestDownloadAgentLoadId) {
      console.log("[DA] Ignoring stale popup refresh", { loadId });
      return;
    }

    if (!payload?.ok) {
      console.error("[DA] Error loading files:", payload?.error);
      setDownloadAgentStatus(payload?.error || "Unavailable");
      renderDownloadAgentFiles(currentDownloadAgentPayload?.files || []);

      if (currentDownloadAgentPayload) {
        scheduleDownloadAgentPolling(currentDownloadAgentPayload.files);
      }

      return;
    }

    currentDownloadAgentPayload = payload;
    setDownloadAgentStatus(
      payload.files.length === 1 ? "1 file" : `${payload.files.length} files`,
    );
    renderDownloadAgentFiles(payload.files);
    scheduleDownloadAgentPolling(payload.files);
  } catch (error) {
    if (loadId !== latestDownloadAgentLoadId) {
      console.log("[DA] Ignoring stale popup refresh error", { loadId });
      return;
    }

    console.error("[DA] Error loading files:", error);
    setDownloadAgentStatus("Unavailable");
    renderDownloadAgentFiles(currentDownloadAgentPayload?.files || []);

    if (currentDownloadAgentPayload) {
      scheduleDownloadAgentPolling(currentDownloadAgentPayload.files);
    }
  }
}

function setDownloadAgentStatus(text) {
  const status = document.getElementById("download-agent-status");

  if (status) {
    status.textContent = text;
  }
}

function renderDownloadAgentFiles(files) {
  const container = document.getElementById("download-agent-files");
  container.textContent = "";

  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "download-agent-row";
    empty.textContent = "No portal download links found.";
    container.appendChild(empty);
    return;
  }

  files.forEach((file) => {
    const row = document.createElement("div");
    row.className = "download-agent-row";

    const labelWrap = document.createElement("div");
    const label = document.createElement("div");
    label.className = "download-agent-file-name";
    label.title = file.fileName;
    label.textContent = file.fileName;
    labelWrap.appendChild(label);

    if (file.status === "failed" && file.error) {
      const error = document.createElement("div");
      error.className = "download-agent-error";
      error.textContent = file.error;
      labelWrap.appendChild(error);
    }

    const button = document.createElement("button");
    configureActionButton(button, file);

    row.appendChild(labelWrap);
    row.appendChild(button);
    container.appendChild(row);
  });
}

function scheduleDownloadAgentPolling(files) {
  if (downloadAgentPollTimer) {
    clearTimeout(downloadAgentPollTimer);
    downloadAgentPollTimer = null;
  }

  if (!files.some((file) => file.status === "preparing")) {
    return;
  }

  downloadAgentPollTimer = setTimeout(() => {
    console.log("[DA] Polling while preparation is in progress");
    loadDownloadAgentFiles({ showLoading: false });
  }, DOWNLOAD_AGENT_POLL_INTERVAL_MS);
}

function configureActionButton(button, file) {
  if (file.status === "ready") {
    setButtonLabel(button, "View");
    button.classList.add("action-view");
    button.addEventListener("click", async () => {
      console.log("[DA] Opening launch file through server", file);
      try {
        const response = await sendRuntimeMessage({
          action: "view_download_agent_file",
          file,
        });

        if (!response?.ok) {
          console.error("[DA] View failed:", response?.error);
          loadDownloadAgentFiles();
        }
      } catch (error) {
        console.error("[DA] View message failed:", error);
        loadDownloadAgentFiles();
      }
    });
    return;
  }

  if (file.status === "preparing") {
    setPreparingButton(button);
    button.disabled = true;
    return;
  }

  if (!file.canPrepare) {
    setButtonLabel(button, "Unavailable");
    button.disabled = true;
    return;
  }

  const isRetry = file.status === "failed";
  setButtonLabel(button, isRetry ? "Retry" : "Prepare");

  if (isRetry) {
    button.classList.add("action-retry");
  }

  button.addEventListener("click", async () => {
    console.log("[DA] Prepare requested", file);
    setPreparingButton(button);
    button.disabled = true;

    try {
      const response = await sendRuntimeMessage({
        action: "prepare_download_agent_file",
        file,
      });

      if (!response?.ok) {
        console.error("[DA] Prepare failed:", response?.error);
      }
    } catch (error) {
      console.error("[DA] Prepare message failed:", error);
    } finally {
      loadDownloadAgentFiles();
    }
  });
}

function setButtonLabel(button, label) {
  button.textContent = "";

  const text = document.createElement("span");
  text.textContent = label;
  button.appendChild(text);
}

function setPreparingButton(button) {
  button.textContent = "";

  const spinner = document.createElement("span");
  spinner.className = "loading-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.textContent = "Preparing...";

  button.appendChild(spinner);
  button.appendChild(text);
}
