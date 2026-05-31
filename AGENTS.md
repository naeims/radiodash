# Context

- This repo is a collection of tools that assist a radiologist in their daily tasks.
- Currently composed of a Chrome Extension in `extension`, a local web server in `server`, and a test portal for development purposes in `test-portal`

## Chrome extension

- Under `extension` folder.
- Presents a menu of templates to the user. User clicks a template and based on the case metadata on the current portal page, a prefilled DOCX template is downloaded to the user's computer.

## Web server

- Under `server` folder.
- Local server that serves the template list, and handles DOCX generation requests from the Chrome extension.
- During development, this server is run inside WSL. In production, there is no WSL and the server runs in Windows using pm2.

## Test portal

- Under `test-portal` folder.
- Pared down radiology portal that is used during development (to avoid hitting production).


# Project plan

## Requirements

- Add a new feature: Download Agent (DA) that streamlines the download -> unpack -> open case workflow for the radiologist.
- Current workflow: Go to case page on portal -> Click download link -> Unpack file on computer -> Find launch file -> Click launch file to open in Invivo software.
- Problem: Unpacking process is not ideal: Each case file is different. Some are .inv files (native Invivo file), some are zip files, and inside the zip file the directory/file structure is vastly different.
- Solve by implementing new radiologist workflow: Go to case page -> Chrome extension lists download links with option to prepare -> Click "Prepare" -> Wait -> Click "View" opens in Invivo. 

## Technical details

- Download links on the portal page can be found by querying the DOM. Look at example portal page in `test-portal` for expected DOM structure. Note there can be multiple links per case.
- The actual act of downloading the file must be done by the browser, to ensure auth and the correct headers are sent.
- Unpacked files must be managed in a temp directory. The local path to the launch file is sent back to the Chrome extension. The "View" button launches this path.
- For a solo .inv file, let's still copy it into the temp directory and manage it like any other case file (e.g. zip).
- The UI state exposed for each file in the Chrome extension must map directly to the file system state:
  1. When file is not downloaded -> Prepare button
  2. While file is downloading -> Preparing state
  3. While unpacking / determining launch file -> Preparing state
  4. When unpacked & launch file is determined -> View button
- Chrome extension UI must have a button to rehydrate the UI from the server source of truth state (e.g. state of file system with case files and unpacked files)


### Determing the launch file

- Use a local LLM for determining the launch file. Assume Ollama is installed and use the V1 completions API.
- Prompt to the LLM should include an abriged version of the directory structure for a case file, and the output should be the most likely launch file. Abriged version means that it should preserve the entire directory structure, but it doesn't need every single file listed. For example, if a directory has 500 DCM files, then the prompt should not include all 500 files, but maybe one file at that path, with a note that says "... and 499 more files".

## Ways of working

- Add helpful console logs so developers can track the flow and debug issues.
- Do not add any tests - first let's get the functionality complete. We will do tests at a later time.
- Do not unzip or peek inside the files under `test-portal/files` for privacy reasons.
- Ask me a lot of questions until we are both satisfied that we are on the same page.
