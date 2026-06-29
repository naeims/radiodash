# Context

This repo contains a Chrome extension that is used by an oral and maxillofacial radiologist as an assistant on top of a portal they use. The workflow that this extension enables is:
1. Radiologist navigates to a patient case in a portal
2. Clicks on the extension
3. Extension presents a list of available templates
4. Radiologist picks a template
5. Extension, with the help of a local web server, serves a DOCX file that is prefilled with metadata about the patient case.
6. Radiologist writes their observations, findings, impressions, etc. about the case in that DOCX file and submit it.

# Directory structure

- `/extension` contains the Chrome extension code.
- `/server` contains the web server code.

# Deployment

Currently, the extension is loaded into Chrome as an unpacked extension. The web server runs locally in WSL on the machine. A pm2 script ensures the web server runs on startup. Template file are colocated inside the web server directory.

# Next steps

We want to deploy the web server to the cloud so it doesn't have to be run on the radiologist's computer locally.

Flesh this requirement out.
