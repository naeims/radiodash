const toggle = document.getElementById("auto-prepare-toggle");
const deleteTempButton = document.getElementById("delete-temp-button");
const status = document.getElementById("settings-status");

document.addEventListener("DOMContentLoaded", () => {
  loadAutoPrepareSetting();

  toggle.addEventListener("change", () => {
    saveAutoPrepareSetting(toggle.checked);
  });

  deleteTempButton.addEventListener("click", () => {
    deleteDownloadAgentTemp();
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

async function loadAutoPrepareSetting() {
  setStatus("Loading");
  toggle.disabled = true;

  try {
    const response = await sendRuntimeMessage({
      action: "get_auto_prepare_setting",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not load setting");
    }

    toggle.checked = response.enabled;
    setStatus(response.enabled ? "Auto-prepare is on" : "Auto-prepare is off");
  } catch (error) {
    console.error("[DA] Failed to load auto-prepare setting:", error);
    setStatus("Setting unavailable");
  } finally {
    toggle.disabled = false;
  }
}

async function saveAutoPrepareSetting(enabled) {
  const previousValue = !enabled;

  toggle.disabled = true;
  setStatus("Saving");

  try {
    const response = await sendRuntimeMessage({
      action: "set_auto_prepare_setting",
      enabled,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not save setting");
    }

    toggle.checked = response.enabled;
    setStatus(response.enabled ? "Auto-prepare is on" : "Auto-prepare is off");
  } catch (error) {
    console.error("[DA] Failed to save auto-prepare setting:", error);
    toggle.checked = previousValue;
    setStatus("Could not save setting");
  } finally {
    toggle.disabled = false;
  }
}

async function deleteDownloadAgentTemp() {
  deleteTempButton.disabled = true;
  setStatus("Deleting temp directory");

  try {
    const response = await sendRuntimeMessage({
      action: "delete_download_agent_temp",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not delete temp directory");
    }

    setStatus("Temp directory deleted");
  } catch (error) {
    console.error("[DA] Failed to delete temp directory:", error);
    setStatus("Could not delete temp directory");
  } finally {
    deleteTempButton.disabled = false;
  }
}

function setStatus(text) {
  status.textContent = text;
}
