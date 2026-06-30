import { NextRequest, NextResponse } from "next/server";
import { ToolLoopAgent, hasToolCall } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { createGateway } from "@ai-sdk/gateway";
import { getDb, ensureSchema, getProcessedCaseIds, insertReport } from "@/lib/db";
import { buildGenerationMeta, type FeedCase } from "@/lib/case-data";
import { extractUrl } from "@/lib/mcp-result";

export const maxDuration = 300;

const MAX_CASES_PER_RUN = 3;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is not set`);
  return val;
}

function checkCronAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === process.env.CRON_SECRET;
}

export async function POST(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mockUrl = requireEnv("MOCK_URL");
  const selfUrl = requireEnv("NEXT_PUBLIC_BASE_URL");
  const mcpToken = process.env.MCP_TOKEN || process.env.API_TOKEN || "";
  const agentModel = process.env.AGENT_MODEL ?? "anthropic/claude-haiku-4-5";

  const sql = getDb();
  await ensureSchema(sql);

  const casesRes = await fetch(`${mockUrl}/api/cases`);
  if (!casesRes.ok) {
    return NextResponse.json(
      { error: `Failed to fetch cases: ${casesRes.status}` },
      { status: 502 }
    );
  }
  const allCases: FeedCase[] = await casesRes.json();

  const processed = await getProcessedCaseIds(sql);
  const pending = allCases.filter((c) => !processed.has(c.id));
  const toProcess = pending.slice(0, MAX_CASES_PER_RUN);

  const results: { case_id: string; status: string; error?: string }[] = [];

  for (const feedCase of toProcess) {
    const mcpClient = await createMCPClient({
      transport: {
        type: "http" as const,
        url: `${selfUrl}/api/mcp/mcp`,
        headers: { Authorization: `Bearer ${mcpToken}` },
      },
    });

    try {
      const tools = await mcpClient.tools();

      const { data, filename } = buildGenerationMeta(feedCase);

      const gateway = createGateway({
        apiKey: process.env.AI_GATEWAY_API_KEY,
      });
      const model = gateway(agentModel);

      const agent = new ToolLoopAgent({
        model,
        tools,
        stopWhen: hasToolCall("generate_document"),
        instructions: [
          "You are an assistant that selects the correct radiology report template and generates a document.",
          "You must call list_templates first to see available templates.",
          "Then pick the most appropriate template based on the study purpose.",
          "Then call generate_document with the selected template and the provided data object.",
          "Do not produce any text response — only the tool calls are needed.",
        ].join(" "),
      });

      const prompt = [
        `Process the following patient case and generate a report document.`,
        `Case ID: ${feedCase.id}`,
        `Patient: ${feedCase.patient_name}`,
        `Study purpose: ${feedCase.study_purpose}`,
        `Clinical notes: ${feedCase.clinical_notes}`,
        `The data object to pass to generate_document is: ${JSON.stringify(data)}`,
      ].join("\n");

      const result = await agent.generate({ prompt });

      let blobUrl: string | null = null;
      let templateUsed: string | null = null;

      for (const step of result.steps) {
        for (const call of step.toolCalls ?? []) {
          if (call.toolName === "generate_document") {
            // Dynamic tool calls expose inputs via `input`
            const input = call.input as { template?: string } | undefined;
            templateUsed = input?.template ?? null;
          }
        }
        for (const tr of step.toolResults ?? []) {
          if (tr.toolName === "generate_document") {
            blobUrl = extractUrl(tr.output) ?? blobUrl;
          }
        }
      }

      if (!blobUrl) {
        throw new Error(
          `Agent finished without generating a document (template=${templateUsed ?? "none"})`
        );
      }

      await insertReport(sql, {
        case_id: feedCase.id,
        patient_name: feedCase.patient_name,
        template: templateUsed,
        blob_url: blobUrl,
        filename,
        status: "done",
      });

      results.push({ case_id: feedCase.id, status: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error processing case ${feedCase.id}:`, message);

      await insertReport(sql, {
        case_id: feedCase.id,
        patient_name: feedCase.patient_name,
        template: null,
        blob_url: null,
        filename: null,
        status: "error",
        error: message,
      });

      results.push({ case_id: feedCase.id, status: "error", error: message });
    } finally {
      await mcpClient.close();
    }
  }

  return NextResponse.json({
    processed: toProcess.length,
    skipped: pending.length - toProcess.length,
    results,
  });
}
