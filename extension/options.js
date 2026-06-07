const autoPrepareToggle = document.getElementById("auto-prepare-toggle");
const tooltipsToggle = document.getElementById("tooltips-toggle");
const deleteTempButton = document.getElementById("delete-temp-button");
const status = document.getElementById("settings-status");

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();

  autoPrepareToggle.addEventListener("change", () => {
    saveAutoPrepareSetting(autoPrepareToggle.checked);
  });

  tooltipsToggle.addEventListener("change", () => {
    saveTooltipsSetting(tooltipsToggle.checked);
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

async function loadSettings() {
  setStatus("Loading");

  const results = await Promise.all([
    loadAutoPrepareSetting(),
    loadTooltipsSetting(),
  ]);

  if (results.every(Boolean)) {
    setStatus("Settings loaded");
  }
}

async function loadAutoPrepareSetting() {
  autoPrepareToggle.disabled = true;

  try {
    const response = await sendRuntimeMessage({
      action: "get_auto_prepare_setting",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not load setting");
    }

    autoPrepareToggle.checked = response.enabled;
  } catch (error) {
    console.error("[DA] Failed to load auto-prepare setting:", error);
    setStatus("Setting unavailable");
    return false;
  } finally {
    autoPrepareToggle.disabled = false;
  }

  return true;
}

async function loadTooltipsSetting() {
  tooltipsToggle.disabled = true;

  try {
    const response = await sendRuntimeMessage({
      action: "get_tooltips_setting",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not load setting");
    }

    tooltipsToggle.checked = response.enabled;
  } catch (error) {
    console.error("[DA] Failed to load tooltip setting:", error);
    setStatus("Setting unavailable");
    return false;
  } finally {
    tooltipsToggle.disabled = false;
  }

  return true;
}

async function saveAutoPrepareSetting(enabled) {
  const previousValue = !enabled;

  autoPrepareToggle.disabled = true;
  setStatus("Saving");

  try {
    const response = await sendRuntimeMessage({
      action: "set_auto_prepare_setting",
      enabled,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not save setting");
    }

    autoPrepareToggle.checked = response.enabled;
    setStatus(response.enabled ? "Auto-prepare is on" : "Auto-prepare is off");
  } catch (error) {
    console.error("[DA] Failed to save auto-prepare setting:", error);
    autoPrepareToggle.checked = previousValue;
    setStatus("Could not save setting");
  } finally {
    autoPrepareToggle.disabled = false;
  }
}

async function saveTooltipsSetting(enabled) {
  const previousValue = !enabled;

  tooltipsToggle.disabled = true;
  setStatus("Saving");

  try {
    const response = await sendRuntimeMessage({
      action: "set_tooltips_setting",
      enabled,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not save setting");
    }

    tooltipsToggle.checked = response.enabled;
    setStatus(response.enabled ? "Tooltips are on" : "Tooltips are off");
  } catch (error) {
    console.error("[DA] Failed to save tooltip setting:", error);
    tooltipsToggle.checked = previousValue;
    setStatus("Could not save setting");
  } finally {
    tooltipsToggle.disabled = false;
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
