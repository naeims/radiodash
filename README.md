# RadioDash

Assistant dashboard for radiologists. A Chrome extension reads case metadata
from the radiology portal and downloads a prefilled DOCX report template with
one click, backed by a local server that renders the templates.

## Structure

- `extension/` — Chrome extension (Manifest V3). Adds a popup listing report
  templates; picking one grabs the current case's metadata from the page and
  requests a filled-in DOCX from the server.
- `server/` — Express server run locally in WSL. Serves the template list,
  fills DOCX templates (`docxtemplater`/`pizzip`) with case data, and returns
  the file to the extension.
- `test-portal/` — Minimal fake radiology portal used for development, so the
  extension can be tested without hitting the production portal.

## Setup

1. Install server dependencies: `cd server && npm install`
2. Start the server: `npm start` (serves on `http://localhost:5000`)
3. Load `extension/` as an unpacked extension in Chrome
   (`chrome://extensions` → Developer mode → Load unpacked)
4. Optionally run `test-portal/` (`node server.js`) to develop against fake
   case data instead of production

For running the server persistently via PM2 at Windows/WSL startup, see
[docs/wsl-pm2-startup.md](docs/wsl-pm2-startup.md).
