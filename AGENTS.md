# Context

- A collection of tools that assist a radiologist in their daily tasks.
- Composed of a Chrome Extension in `extension` and a local web server in `server`.

## Chrome extension

- Lives under `extension`.
- Presents a menu of templates to the user.
- The list of templates are queried from the web server.
- When the user clicks a template, the extension scrapes the current page (assumed to be the portal details for the case) for metadata about the case.
- Then it calls the web server with this metadata.
- The web server responds with a docx file that the extension will subsequently download to the user's computer.

## Web server

- Lives under `server`
- Has a list of templates under the `templates` directory as DOCX files
- These files have a particular templated format
- Chrome extension calls the web server with a particular template name and metadata
- Server populates the DOCX file with metadata and returns it


# Project plan

- This is an existing legacy codebase.
- We need to do a cleanup pass: 
  1. Make sure all code makes sense.
  2. Add some tests
  3. Clean up gitignore
