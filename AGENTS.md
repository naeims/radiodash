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

### Auto-prepare case files

The chrome extension currently exposes a Prepare button to the user. User presses Prepare. Download -> Unpack -> Launch file detection happens. Button turns into View. User presses View.

Modify this such that Prepare is clicked automatically when the page loads (and Prepare is available).

New flow will be:

1. User goes to case page
2. Chrome extension looks to see if file is already prepared or not. Chrome extension's UI does not have to be opened to initiate this, it should be kicked off of page load or some other trigger.
3. If not prepared, Chrome extension will automatically initiate the Prepare flow. At this point if user opens the UI they should see "Preparing..."
4. If already prepared, Chrome extension will not do anything, and by virtue of the functionality that already exists, user should see a View button.

### Update Test Portal

Enhance the test portal to:
1. New page to display a list of patients
2. Each patient will be mapped to a single test file
3. One patient (pick one, any one) will have two test files (so we can test the multiple files case)


Notes:
- Do not write any tests, I will test this manually