document.addEventListener("DOMContentLoaded", () => {
  const serverUrlInput = document.getElementById("server-url");
  const apiTokenInput = document.getElementById("api-token");
  const saveBtn = document.getElementById("save-btn");
  const statusEl = document.getElementById("status");

  chrome.storage.local.get(["serverUrl", "token"], (result) => {
    if (result.serverUrl) serverUrlInput.value = result.serverUrl;
    if (result.token) apiTokenInput.value = result.token;
  });

  saveBtn.addEventListener("click", () => {
    const serverUrl = serverUrlInput.value.trim().replace(/\/$/, "");
    const token = apiTokenInput.value.trim();

    chrome.storage.local.set({ serverUrl, token }, () => {
      statusEl.textContent = "Saved.";
      setTimeout(() => {
        statusEl.textContent = "";
      }, 2000);
    });
  });
});
