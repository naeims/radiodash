// Returns a 401 that triggers the browser's built-in Basic Auth dialog.
export function GET() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Radiology Reports", charset="UTF-8"',
    },
  });
}
