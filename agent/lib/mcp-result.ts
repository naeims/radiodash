// MCP tool results can surface in several shapes depending on AI SDK / transport:
// a JSON string, an array of content parts, or an object with content/value/output.
// Recursively search for the { url } payload our generate_document tool returns.
export function extractUrl(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === "string") {
    try {
      return extractUrl(JSON.parse(output));
    } catch {
      return null;
    }
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const u = extractUrl(item);
      if (u) return u;
    }
    return null;
  }
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.url === "string") return o.url;
    for (const key of ["text", "content", "value", "output"]) {
      if (key in o) {
        const u = extractUrl(o[key]);
        if (u) return u;
      }
    }
  }
  return null;
}
