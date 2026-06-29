chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "generate_document") {
    console.log(
      "Received generate_document action with template:",
      request.template,
    );

    chrome.storage.local.get(["serverUrl", "token"], (config) => {
      const { serverUrl, token } = config;

      if (!serverUrl || !token) {
        console.error("Server URL or token not configured.");
        return;
      }

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
              args: [activeTabUrl, request.template, serverUrl, token],
            },
            (results) => {
              if (chrome.runtime.lastError) {
                console.error(
                  "Script injection error:",
                  chrome.runtime.lastError,
                );
              } else {
                console.log("Script injected successfully:", results);
              }
            },
          );
        } else {
          console.error("No active tab found");
        }
      });
    });
  }

  // Return true to keep the message channel open for async response
  return true;
});

function collectAndSendData(pageUrl, template, serverUrl, token) {
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

  fetch(`${serverUrl}/generate_document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
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
