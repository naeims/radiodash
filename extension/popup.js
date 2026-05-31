const SERVER_BASE_URL = "http://localhost:5000";
const DOWNLOAD_AGENT_POLL_INTERVAL_MS = 2000;

let currentDownloadAgentPayload = null;
let downloadAgentPollTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  loadTemplates();
  loadDownloadAgentFiles();

  document
    .getElementById("download-agent-refresh")
    .addEventListener("click", () => {
      console.log("[DA] Manual refresh requested");
      loadDownloadAgentFiles();
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

function loadTemplates() {
  fetch(`${SERVER_BASE_URL}/templates`)
    .then((response) => response.json())
    .then((templates) => {
      const templateButtons = document.getElementById("template-buttons");
      templateButtons.textContent = "";

      templates.forEach((template) => {
        const button = document.createElement("button");
        button.textContent = template;
        button.addEventListener("click", () => {
          chrome.runtime.sendMessage(
            { action: "generate_document", template: template },
            (response) => {
              console.log("Response from background:", response);
            },
          );
        });
        templateButtons.appendChild(button);
      });
    })
    .catch((error) => {
      console.error("Error fetching templates:", error);
    });
}

function loadDownloadAgentFiles(options = {}) {
  const { showLoading = true } = options;

  if (showLoading) {
    setDownloadAgentStatus("Loading");
  }

  chrome.runtime.sendMessage(
    { action: "get_download_agent_files" },
    (payload) => {
      if (chrome.runtime.lastError) {
        console.error("[DA] Error loading files:", chrome.runtime.lastError);
        setDownloadAgentStatus("Unavailable");
        renderKnownDownloadAgentFallback();
        return;
      }

      if (!payload?.ok) {
        console.error("[DA] Error loading files:", payload?.error);
        setDownloadAgentStatus(payload?.error || "Unavailable");
        renderKnownDownloadAgentFallback();
        return;
      }

      currentDownloadAgentPayload = payload;
      setDownloadAgentStatus(
        payload.files.length === 1 ? "1 file" : `${payload.files.length} files`,
      );
      renderDownloadAgentFiles(payload.files);
      scheduleDownloadAgentPolling(payload.files);
    },
  );
}

function setDownloadAgentStatus(text) {
  document.getElementById("download-agent-status").textContent = text;
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

function renderKnownDownloadAgentFallback() {
  if (currentDownloadAgentPayload) {
    renderDownloadAgentFiles(currentDownloadAgentPayload.files);
    scheduleDownloadAgentPolling(currentDownloadAgentPayload.files);
    return;
  }

  renderDownloadAgentFiles([]);
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
    button.textContent = "View";
    button.addEventListener("click", () => {
      console.log("[DA] Opening launch file through server", file);
      chrome.runtime.sendMessage(
        {
          action: "view_download_agent_file",
          file,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error(
              "[DA] View message failed:",
              chrome.runtime.lastError,
            );
            loadDownloadAgentFiles();
            return;
          }

          if (!response?.ok) {
            console.error("[DA] View failed:", response?.error);
            loadDownloadAgentFiles();
          }
        },
      );
    });
    return;
  }

  if (file.status === "preparing") {
    button.textContent = "Preparing";
    button.disabled = true;
    return;
  }

  if (!file.canPrepare) {
    button.textContent = "Unavailable";
    button.disabled = true;
    return;
  }

  button.textContent = file.status === "failed" ? "Retry" : "Prepare";
  button.addEventListener("click", () => {
    console.log("[DA] Prepare requested", file);
    button.textContent = "Preparing";
    button.disabled = true;
    chrome.runtime.sendMessage(
      { action: "prepare_download_agent_file", file },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[DA] Prepare message failed:",
            chrome.runtime.lastError,
          );
          loadDownloadAgentFiles();
          return;
        }

        if (!response?.ok) {
          console.error("[DA] Prepare failed:", response?.error);
        }

        loadDownloadAgentFiles();
      },
    );
  });
}
