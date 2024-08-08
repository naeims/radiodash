document.getElementById("generate").addEventListener("click", () => {
  console.log("Generate button clicked");
  chrome.runtime.sendMessage({ action: "generate_document" }, (response) => {
    console.log("Response from background:", response);
  });
});
