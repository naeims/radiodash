// Deterministic mapping from a feed case to the data object expected by the Express docx server.
// Mirrors the field computation in extension/background.js extractData and collectAndSendData.

export interface FeedCase {
  id: string;
  pid: string;
  sid: string;
  patient_name: string;
  patient_dob: string;
  patient_age: string;
  patient_gender: string;
  study_purpose: string;
  clinical_notes: string;
  requesting_doctor: string;
  submitting_group: string;
  scan_date: string;
}

export interface DocxData {
  pid: string;
  sid: string;
  patient_name: string;
  patient_dob: string;
  patient_age: string;
  patient_gender: string;
  study_purpose: string;
  clinical_notes: string;
  requesting_doctor: string;
  submitting_group: string;
  scan_date: string;
  report_date: string;
  utc_time: string;
}

export interface GenerationMeta {
  data: DocxData;
  filename: string;
}

function formatReportDate(now: Date): string {
  const day = String(now.getDate());
  const month = String(now.getMonth() + 1);
  const year = now.getFullYear();
  return `${month}/${day}/${year}`;
}

function formatUTCTime(now: Date): string {
  const day = String(now.getUTCDate()).padStart(2, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const year = String(now.getUTCFullYear()).slice(2);
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, "0");
  return `${month}${day}${year}${hours}${minutes}${seconds}${milliseconds}`;
}

export function buildGenerationMeta(feedCase: FeedCase, now: Date = new Date()): GenerationMeta {
  const report_date = formatReportDate(now);
  const utc_time = formatUTCTime(now);

  const data: DocxData = {
    pid: feedCase.pid,
    sid: feedCase.sid,
    patient_name: feedCase.patient_name,
    patient_dob: feedCase.patient_dob,
    patient_age: feedCase.patient_age,
    patient_gender: feedCase.patient_gender,
    study_purpose: feedCase.study_purpose,
    clinical_notes: feedCase.clinical_notes,
    requesting_doctor: feedCase.requesting_doctor,
    submitting_group: feedCase.submitting_group,
    scan_date: feedCase.scan_date,
    report_date,
    utc_time,
  };

  const patientNameForFile = feedCase.patient_name.replace(/\s+/g, "_");
  const filename = `RadReport_${patientNameForFile}_${utc_time}_MA.docx`;

  return { data, filename };
}
