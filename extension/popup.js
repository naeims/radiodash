const SERVER_BASE_URL = "http://localhost:5000";
const DOWNLOAD_AGENT_POLL_INTERVAL_MS = 2000;

let currentDownloadAgentPayload = null;
let downloadAgentPollTimer = null;
let latestDownloadAgentLoadId = 0;
let showTooltips = true;

document.addEventListener("DOMContentLoaded", async () => {
  await loadTooltipsSetting();
  applyStaticTooltips();
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

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".view-dropdown")) {
      closeViewDropdowns();
    }
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
    setTooltip(label, file.fileName);
    label.textContent = file.fileName;
    labelWrap.appendChild(label);

    if (file.status === "failed" && file.error) {
      const error = document.createElement("div");
      error.className = "download-agent-error";
      error.textContent = file.error;
      labelWrap.appendChild(error);
    }

    const action = createActionControl(file);

    row.appendChild(labelWrap);
    row.appendChild(action);
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

function createActionControl(file) {
  if (file.status === "ready" && getLaunchFiles(file).length > 1) {
    return createViewDropdown(file);
  }

  const button = document.createElement("button");
  button.className = "download-agent-action-button";
  configureActionButton(button, file);

  return button;
}

function configureActionButton(button, file) {
  if (file.status === "ready") {
    setButtonLabel(button, "View");
    button.classList.add("action-view");
    setTooltip(button, getLaunchFileTooltipText(getLaunchFiles(file)));
    button.addEventListener("click", async () => {
      await openLaunchFile(file, 0);
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

function getLaunchFiles(file) {
  if (Array.isArray(file.launchFiles) && file.launchFiles.length > 0) {
    return file.launchFiles;
  }

  if (file.launchFileUrl) {
    return [
      {
        index: 0,
        label: file.fileName || "Scan 1",
        relativeLaunchPath: file.fileName || "Scan 1",
        launchFileUrl: file.launchFileUrl,
      },
    ];
  }

  return [];
}

function createViewDropdown(file) {
  const launchFiles = getLaunchFiles(file);
  const wrapper = document.createElement("div");
  wrapper.className = "view-dropdown";

  const trigger = document.createElement("button");
  trigger.className = "download-agent-action-button action-view";
  trigger.type = "button";
  setTooltip(trigger, getLaunchFileTooltipText(launchFiles));
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  setButtonLabel(trigger, "View");
  trigger.firstElementChild?.classList.add("view-dropdown-label");

  const caret = document.createElement("span");
  caret.className = "view-dropdown-caret";
  caret.setAttribute("aria-hidden", "true");
  trigger.appendChild(caret);

  const menu = document.createElement("div");
  menu.className = "view-dropdown-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");

  launchFiles.forEach((launchFile, index) => {
    const option = document.createElement("button");
    const label = getLaunchFileLabel(launchFile, index);

    option.className = "view-dropdown-option";
    option.type = "button";
    option.setAttribute("role", "menuitem");
    option.textContent = label;
    setTooltip(option, getLaunchFileTooltipText([launchFile], index));
    option.addEventListener("click", async (event) => {
      event.stopPropagation();
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      await openLaunchFile(file, launchFile.index ?? index);
    });

    menu.appendChild(option);
  });

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;

    closeViewDropdowns(wrapper);
    menu.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", String(willOpen));
  });

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);

  return wrapper;
}

function closeViewDropdowns(except = null) {
  document.querySelectorAll(".view-dropdown").forEach((dropdown) => {
    if (dropdown === except) {
      return;
    }

    const menu = dropdown.querySelector(".view-dropdown-menu");
    const trigger = dropdown.querySelector(".download-agent-action-button");

    if (menu) {
      menu.hidden = true;
    }

    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
    }
  });
}

function getLaunchFileLabel(launchFile, index) {
  const label =
    typeof launchFile.label === "string" && launchFile.label.trim() !== ""
      ? launchFile.label.trim()
      : `Scan ${index + 1}`;

  return label;
}

function getLaunchFileTooltipText(launchFiles, fallbackIndex = 0) {
  return launchFiles
    .map((launchFile, index) => {
      if (
        typeof launchFile.relativeLaunchPath === "string" &&
        launchFile.relativeLaunchPath.trim() !== ""
      ) {
        return launchFile.relativeLaunchPath.trim();
      }

      return getLaunchFileLabel(launchFile, fallbackIndex + index);
    })
    .join("\n");
}

async function loadTooltipsSetting() {
  try {
    const response = await sendRuntimeMessage({
      action: "get_tooltips_setting",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not load setting");
    }

    showTooltips = response.enabled !== false;
  } catch (error) {
    console.error("[DA] Failed to load tooltip setting:", error);
    showTooltips = true;
  }
}

function applyStaticTooltips() {
  document.querySelectorAll("[data-tooltip]").forEach((element) => {
    setTooltip(element, element.dataset.tooltip);
  });
}

function setTooltip(element, text) {
  if (showTooltips && typeof text === "string" && text.trim() !== "") {
    element.title = text.trim();
    return;
  }

  element.removeAttribute("title");
}

async function openLaunchFile(file, launchFileIndex) {
  console.log("[DA] Opening launch file through server", {
    file,
    launchFileIndex,
  });

  try {
    const response = await sendRuntimeMessage({
      action: "view_download_agent_file",
      file,
      launchFileIndex,
    });

    if (!response?.ok) {
      console.error("[DA] View failed:", response?.error);
      loadDownloadAgentFiles();
    }
  } catch (error) {
    console.error("[DA] View message failed:", error);
    loadDownloadAgentFiles();
  }
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
