# Context

- This repo is a collection of tools that assist a radiologist in their daily tasks.
- Currently composed of a Chrome Extension in `extension`, a local web server in `server`, and a test portal for development purposes in `test-portal`

## Chrome extension

- Under `extension` folder.
- Presents a menu of templates to the user. User clicks a template and based on the case metadata on the current portal page, a prefilled DOCX template is downloaded to the user's computer.

## Web server

- Under `server` folder.
- Local server that serves the template list, handles DOCX generation, and case download requests from the Chrome extension.
- The server runs inside WSL in development and production. In production it is wrapped by pm2.

## Test portal

- Under `test-portal` folder.
- Pared down radiology portal that is used during development (to avoid hitting production).


## Next steps

We need to support niche caess where a single file contains multiple radiology scans.

An example of this can be found under `test/test-cases.txt` -> TEST_10

The expected UI is that we will still have a single Prepare button, but when the download, extraction, and LLM call are done, instead of
exposing a single View button, we will show a View dropdown (visually similar to the View button but with a down arrow) and upon clicking
this dropdown, the user will be presented with both options.

The LLM response in this case will contain an array of paths, not a single path. If it's easier for the LLM to always return multiple paths in
an array, but we handle the single-element case by showing the button, and the multi-element case by showing the dropdown, then feel free
to make that change to the LLM response that we expect from the LLM.

We want to make sure that the LLM uses this option sparingly. For all the other test cases it must not return multiple files. But the prompt
must be constructed in a way that the LLM understands the structure of this particular scan actually contains two scans.

Do not make the prompt "overfit" this special case as it must be able to be generalized.

Very Important: Do not add any complex logic to server.js for producing the directory listing to feed to the LLM. Also do not add
any logic to server.js that special-cases directory names inside the case files (e.g. do not add any logic or prompt to the effect of
"if directory name is this or that, then it's not a target, etc."). We want the change to detect multiple radiology scans to be
purely prompt based and done by the LLM.

You can run `npm run test:llm` from the server folder to test.
