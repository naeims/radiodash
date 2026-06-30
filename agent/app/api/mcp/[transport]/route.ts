import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { put } from "@vercel/blob";
import { z } from "zod";

export const maxDuration = 300;

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Environment variable ${name} is not set`);
  return val;
}

function bearerVerifier(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const expected = process.env.MCP_TOKEN || process.env.API_TOKEN;
  if (!expected || token !== expected) return undefined;
  return { token, scopes: [], clientId: "mcp-client" } as const;
}

const innerHandler = createMcpHandler(
  (server) => {
    server.tool(
      "list_templates",
      "List all available report templates from the docx server.",
      {},
      async () => {
        const docxUrl = getEnv("DOCX_URL");
        const apiToken = getEnv("API_TOKEN");

        const res = await fetch(`${docxUrl}/templates`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });

        if (!res.ok) {
          throw new Error(`list_templates failed: ${res.status} ${await res.text()}`);
        }

        const templates: string[] = await res.json();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(templates) }],
        };
      }
    );

    server.tool(
      "generate_document",
      "Generate a populated .docx report using the given template and case data. Returns a Blob URL and filename.",
      {
        template: z.string().describe("Template name as returned by list_templates"),
        data: z
          .record(z.unknown())
          .describe("Case data object to fill the template with"),
      },
      async ({ template, data }) => {
        const docxUrl = getEnv("DOCX_URL");
        const apiToken = getEnv("API_TOKEN");

        const res = await fetch(`${docxUrl}/generate_document`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({ template, data }),
        });

        if (!res.ok) {
          throw new Error(`generate_document failed: ${res.status} ${await res.text()}`);
        }

        const buffer = await res.arrayBuffer();

        const patientName =
          typeof data === "object" && data !== null && "patient_name" in data
            ? String((data as Record<string, unknown>).patient_name).replace(/\s+/g, "_")
            : "Unknown";
        const utcTime =
          typeof data === "object" && data !== null && "utc_time" in data
            ? String((data as Record<string, unknown>).utc_time)
            : Date.now().toString();

        const filename = `RadReport_${patientName}_${utcTime}_MA.docx`;

        const blob = await put(filename, buffer, {
          access: "public",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          addRandomSuffix: true,
        });

        const result = { url: blob.url, filename };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      }
    );
  },
  { serverInfo: { name: "radiodash-docx", version: "1.0.0" } },
  { maxDuration: 300, basePath: "/api/mcp" }
);

// @ts-expect-error withMcpAuth wraps the handler; types are compatible at runtime
const protectedHandler = withMcpAuth(innerHandler, bearerVerifier);

export { protectedHandler as GET, protectedHandler as POST, protectedHandler as DELETE };
