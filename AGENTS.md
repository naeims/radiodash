# Context

- This repo is a collection of tools that assist a radiologist in their daily tasks.
- Currently composed of a Chrome Extension in `extension`, a local web server in `server`, and a test portal for development purposes in `test-portal`

## Chrome extension

- Under `extension` folder.
- Presents a menu of templates to the user. User clicks a template and based on the case metadata on the current portal page, a prefilled DOCX template is downloaded to the user's computer.

## Web server

- Under `server` folder.
- Local server that serves the template list, handles DOCX generation, and case download requests from the Chrome extension.
- During development, this server is run inside WSL. In production, there is no WSL and the server runs in Windows using pm2.

## Test portal

- Under `test-portal` folder.
- Pared down radiology portal that is used during development (to avoid hitting production).
