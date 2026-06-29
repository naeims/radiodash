document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["serverUrl", "token"], (config) => {
    const { serverUrl, token } = config;

    if (!serverUrl || !token) {
      const templateButtons = document.getElementById("template-buttons");
      const msg = document.createElement("p");
      msg.style.padding = "10px";
      msg.style.fontSize = "13px";
      msg.style.color = "#666";
      msg.textContent = "Configure server URL and token in extension options.";
      templateButtons.appendChild(msg);
      return;
    }

    fetch(`${serverUrl}/templates`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => response.json())
      .then((templates) => {
        const templateButtons = document.getElementById("template-buttons");
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
  });
});
