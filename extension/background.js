const ALLOWED_DOMAIN = "beamers.beamreaders.com";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "generate_document") {
    console.log("Received generate_document action");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        let activeTab = tabs[0];
        let activeTabId = activeTab.id;
        let activeTabUrl = activeTab.url;

        // Check if the URL matches the allowed domain
        if (activeTabUrl.includes(ALLOWED_DOMAIN)) {
          console.log("Active tab URL:", activeTabUrl);
          chrome.scripting.executeScript(
            {
              target: { tabId: activeTabId },
              function: collectAndSendData,
              args: [activeTabUrl],
            },
            (results) => {
              if (chrome.runtime.lastError) {
                console.error(
                  "Script injection error:",
                  chrome.runtime.lastError
                );
              } else {
                console.log("Script injected successfully:", results);
              }
            }
          );
        } else {
          console.warn(`This extension only works on ${ALLOWED_DOMAIN}`);
        }
      } else {
        console.error("No active tab found");
      }
    });
  }
});

function collectAndSendData(pageUrl) {
  console.log("collectData function called with URL:", pageUrl);

  function extractData(pageUrl) {
    const urlParts = pageUrl.split("/");
    const pidIndex = urlParts.indexOf("patients") + 1;
    const sidIndex = urlParts.indexOf("radiology") + 1;
    const pid = (urlParts[pidIndex] || "N/A").replace(
      /\B(?=(\d{3})+(?!\d))/g,
      ","
    );
    const sid = (urlParts[sidIndex] || "N/A").replace(
      /\B(?=(\d{3})+(?!\d))/g,
      ","
    );

    console.log("Parsed PID:", pid);
    console.log("Parsed SID:", sid);

    const getDetailValue = (labelText) => {
      const detailLabel = Array.from(
        document.querySelectorAll("div.detail-label")
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
        document.querySelectorAll("div.detail-label")
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
        "div.patient-profile-image-name div.f-size-24"
      );
      return nameDiv ? nameDiv.textContent.trim() : "N/A";
    };

    const getStudyPurpose = () => {
      const col5Divs = Array.from(
        document.querySelectorAll(".col-5 .k-card-subtitle")
      );
      const col7Divs = Array.from(
        document.querySelectorAll(".col-7 .hbox .k-card-subtitle")
      );

      const studyPurposeIndex = col5Divs.findIndex(
        (div) => div.textContent.trim() === "Study purpose:"
      );

      if (studyPurposeIndex !== -1 && col7Divs[studyPurposeIndex]) {
        const studyPurposeValue = col7Divs[studyPurposeIndex].querySelector(
          "span.ng-star-inserted"
        );
        return studyPurposeValue ? studyPurposeValue.textContent.trim() : "N/A";
      }

      return "N/A";
    };

    const formatReportDate = () => {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, "0");
      const month = String(now.getMonth() + 1).padStart(2, "0");
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

    const clickViewMoreAndExtractModalValues = () => {
      const viewMoreButton = document.querySelector("a.view-more-link");
      if (viewMoreButton) {
        viewMoreButton.click();

        const scanDateInput = document.querySelector(
          'kendo-floatinglabel[text="Scan Date"] input.k-input-inner'
        );
        const scanDate = scanDateInput ? scanDateInput.value : "N/A";

        const clinicalNotesLabel = Array.from(
          document.querySelectorAll("h3.font-weight-normal")
        ).find((h3) => h3.textContent.trim() === "Doctor's Notes");
        let clinicalNotes = "N/A";
        if (clinicalNotesLabel) {
          const clinicalNotesTextarea = clinicalNotesLabel
            .closest("div.row")
            .querySelector("textarea.k-input-inner");
          clinicalNotes = clinicalNotesTextarea
            ? clinicalNotesTextarea.value.replace(/\n/g, "").trim()
            : "N/A";
        }

        const doneButton = Array.from(
          document.querySelectorAll("button.k-button")
        ).find((button) => button.textContent.trim() === "Done");
        if (doneButton) {
          doneButton.click();
        }

        return { scan_date: scanDate, clinical_notes: clinicalNotes };
      }
      return { scan_date: "N/A", clinical_notes: "N/A" };
    };

    const modalValues = clickViewMoreAndExtractModalValues();
    const utcTime = formatUTCTime();

    return {
      page_url: pageUrl,
      pid: pid,
      sid: sid,
      patient_name: getPatientName(),
      patient_dob: getDetailValue("DOB:"),
      patient_age: getDetailValue("Age:"),
      patient_gender: getDetailValue("Gender:"),
      study_purpose: getStudyPurpose(),
      clinical_notes: modalValues.clinical_notes,
      report_date: formatReportDate(),
      scan_date: modalValues.scan_date,
      requesting_doctor: getLinkValue("Primary Dentist:"),
      submitting_group: getLinkValue("Practice Name:"),
      utc_time: utcTime,
    };
  }

  const data = extractData(pageUrl);
  console.log("Collected data:", data);

  const patientNameForFile = data.patient_name.replace(/\s+/g, "_");
  const fileName = `RadReport_${patientNameForFile}_${data.utc_time}_MA.docx`;

  fetch("http://localhost:5000/generate_document", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  })
    .then((response) => response.blob())
    .then((blob) => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    })
    .catch((error) => {
      console.error("Error:", error);
    });
}
