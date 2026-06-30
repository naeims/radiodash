import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { put } from "@vercel/blob";
import { z } from "zod";
import { createLogger, errFields } from "@/lib/log";

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

// Build a logger correlated to the agent run via the x-run-id / x-case-id headers
// that the agent attaches to the MCP transport. Headers arrive on extra.requestInfo.
function headerVal(extra: unknown, name: string): string | undefined {
  const headers = (extra as { requestInfo?: { headers?: Record<string, unknown> } })?.requestInfo
    ?.headers;
  const v = headers?.[name];
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

function logFromExtra(extra: unknown, tool: string) {
  return createLogger("mcp", {
    runId: headerVal(extra, "x-run-id") ?? null,
    caseId: headerVal(extra, "x-case-id") ?? null,
    tool,
  });
}

const innerHandler = createMcpHandler(
  (server) => {
    server.tool(
      "list_templates",
      "List all available report templates from the docx server.",
      {},
      async (_args, extra) => {
        const log = logFromExtra(extra, "list_templates");
        const start = Date.now();
        log.info("tool.start");
        try {
          const docxUrl = getEnv("DOCX_URL");
          const apiToken = getEnv("API_TOKEN");

          const res = await fetch(`${docxUrl}/templates`, {
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "x-run-id": headerVal(extra, "x-run-id") ?? "",
            },
          });

          if (!res.ok) {
            const body = await res.text();
            log.error("docx.list_failed", { status: res.status, body });
            throw new Error(`list_templates failed: ${res.status} ${body}`);
          }

          const templates: string[] = await res.json();
          log.info("tool.done", { count: templates.length, templates, durationMs: Date.now() - start });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(templates) }],
          };
        } catch (err) {
          log.error("tool.error", { ...errFields(err), durationMs: Date.now() - start });
          throw err;
        }
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
      async ({ template, data }, extra) => {
        const log = logFromExtra(extra, "generate_document");
        const start = Date.now();
        log.info("tool.start", {
          template,
          dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
        });
        try {
          const docxUrl = getEnv("DOCX_URL");
          const apiToken = getEnv("API_TOKEN");

          const res = await fetch(`${docxUrl}/generate_document`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiToken}`,
              "x-run-id": headerVal(extra, "x-run-id") ?? "",
            },
            body: JSON.stringify({ template, data }),
          });

          if (!res.ok) {
            const body = await res.text();
            log.error("docx.generate_failed", { status: res.status, body, template });
            throw new Error(`generate_document failed: ${res.status} ${body}`);
          }

          const buffer = await res.arrayBuffer();
          log.info("docx.rendered", { template, bytes: buffer.byteLength });

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

          log.info("tool.done", {
            template,
            filename,
            blobUrl: blob.url,
            bytes: buffer.byteLength,
            durationMs: Date.now() - start,
          });

          const result = { url: blob.url, filename };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          log.error("tool.error", { ...errFields(err), template, durationMs: Date.now() - start });
          throw err;
        }
      }
    );
  },
  { serverInfo: { name: "radiodash-docx", version: "1.0.0" } },
  { maxDuration: 300, basePath: "/api/mcp" }
);

// @ts-expect-error withMcpAuth wraps the handler; types are compatible at runtime
const protectedHandler = withMcpAuth(innerHandler, bearerVerifier);

export { protectedHandler as GET, protectedHandler as POST, protectedHandler as DELETE };
