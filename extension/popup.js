document.addEventListener("DOMContentLoaded", () => {
  fetch("http://localhost:5000/templates")
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
            }
          );
        });
        templateButtons.appendChild(button);
      });
    })
    .catch((error) => {
      console.error("Error fetching templates:", error);
    });
});
