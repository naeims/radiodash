import { NextRequest, NextResponse } from "next/server";
import { ToolLoopAgent, hasToolCall } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { createGateway } from "@ai-sdk/gateway";
import { randomUUID } from "crypto";
import { getDb, ensureSchema, getProcessedCaseIds, insertReport } from "@/lib/db";
import { buildGenerationMeta, type FeedCase } from "@/lib/case-data";
import { extractUrl } from "@/lib/mcp-result";
import { createLogger, errFields } from "@/lib/log";

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
  const runId = randomUUID();
  const log = createLogger("agent-run", { runId });
  const runStart = Date.now();

  if (!checkCronAuth(req)) {
    log.warn("run.unauthorized", { ua: req.headers.get("user-agent") });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let mockUrl: string;
  let selfUrl: string;
  try {
    mockUrl = requireEnv("MOCK_URL");
    selfUrl = requireEnv("NEXT_PUBLIC_BASE_URL");
  } catch (err) {
    log.error("run.config_error", errFields(err));
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const mcpToken = process.env.MCP_TOKEN || process.env.API_TOKEN || "";
  const agentModel = process.env.AGENT_MODEL ?? "anthropic/claude-haiku-4-5";

  log.info("run.start", { mockUrl, selfUrl, agentModel, maxCases: MAX_CASES_PER_RUN });

  const sql = getDb();
  await ensureSchema(sql);

  const casesRes = await fetch(`${mockUrl}/api/cases`, {
    headers: { "x-run-id": runId },
  });
  if (!casesRes.ok) {
    log.error("cases.fetch_failed", { status: casesRes.status });
    return NextResponse.json(
      { error: `Failed to fetch cases: ${casesRes.status}` },
      { status: 502 }
    );
  }
  const allCases: FeedCase[] = await casesRes.json();

  const processed = await getProcessedCaseIds(sql);
  const pending = allCases.filter((c) => !processed.has(c.id));
  const toProcess = pending.slice(0, MAX_CASES_PER_RUN);

  log.info("cases.fetched", {
    total: allCases.length,
    alreadyProcessed: processed.size,
    pending: pending.length,
    selected: toProcess.length,
    selectedIds: toProcess.map((c) => c.id),
    deferredIds: pending.slice(MAX_CASES_PER_RUN).map((c) => c.id),
  });

  const results: { case_id: string; status: string; template?: string | null; blob_url?: string | null; error?: string }[] = [];

  for (const feedCase of toProcess) {
    const caseLog = log.child({ caseId: feedCase.id });
    const caseStart = Date.now();
    caseLog.info("case.start", {
      patient: feedCase.patient_name,
      study_purpose: feedCase.study_purpose,
    });

    const mcpClient = await createMCPClient({
      transport: {
        type: "http" as const,
        url: `${selfUrl}/api/mcp/mcp`,
        headers: {
          Authorization: `Bearer ${mcpToken}`,
          "x-run-id": runId,
          "x-case-id": feedCase.id,
        },
      },
    });

    try {
      const tools = await mcpClient.tools();
      caseLog.info("mcp.tools_listed", { tools: Object.keys(tools) });

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

      caseLog.info("llm.start", { model: agentModel });
      const result = await agent.generate({ prompt });
      caseLog.info("llm.done", {
        steps: result.steps.length,
        finishReason: result.finishReason,
        usage: result.usage ?? null,
      });

      let blobUrl: string | null = null;
      let templateUsed: string | null = null;

      // This recaps steps already executed inside agent.generate() above; it does not
      // call any tools. Logged as one line (rather than per-call/result events) so it
      // isn't mistaken for a second live invocation in the trace.
      const stepsRecap: { tool: string; input: unknown; result: unknown }[] = [];
      for (const step of result.steps) {
        for (const call of step.toolCalls ?? []) {
          if (call.toolName === "generate_document") {
            // Dynamic tool calls expose inputs via `input`
            const input = call.input as { template?: string } | undefined;
            templateUsed = input?.template ?? null;
          }
          stepsRecap.push({
            tool: call.toolName,
            input: summarizeToolInput(call.toolName, call.input),
            result: null,
          });
        }
        for (const tr of step.toolResults ?? []) {
          const entry = [...stepsRecap].reverse().find((s) => s.tool === tr.toolName && s.result === null);
          if (tr.toolName === "list_templates") {
            const result = { templates: extractTemplates(tr.output) };
            if (entry) entry.result = result;
          }
          if (tr.toolName === "generate_document") {
            blobUrl = extractUrl(tr.output) ?? blobUrl;
            if (entry) entry.result = { blobUrl };
          }
        }
      }
      caseLog.info("llm.steps_recap", { steps: stepsRecap });

      caseLog.info("template.selected", { template: templateUsed });

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
      caseLog.info("db.insert", { status: "done", template: templateUsed, blobUrl });

      caseLog.info("case.done", { template: templateUsed, blobUrl, durationMs: Date.now() - caseStart });
      results.push({ case_id: feedCase.id, status: "done", template: templateUsed, blob_url: blobUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      caseLog.error("case.error", { ...errFields(err), durationMs: Date.now() - caseStart });

      await insertReport(sql, {
        case_id: feedCase.id,
        patient_name: feedCase.patient_name,
        template: null,
        blob_url: null,
        filename: null,
        status: "error",
        error: message,
      });
      caseLog.info("db.insert", { status: "error" });

      results.push({ case_id: feedCase.id, status: "error", error: message });
    } finally {
      await mcpClient.close();
    }
  }

  const summary = {
    processed: toProcess.length,
    succeeded: results.filter((r) => r.status === "done").length,
    failed: results.filter((r) => r.status === "error").length,
    skipped: pending.length - toProcess.length,
    durationMs: Date.now() - runStart,
  };
  log.info("run.summary", summary);

  return NextResponse.json({ runId, ...summary, results });
}

// Keep tool-call logs compact: don't dump the full data object on every call.
function summarizeToolInput(toolName: string, input: unknown): unknown {
  if (toolName !== "generate_document" || typeof input !== "object" || input === null) {
    return input ?? null;
  }
  const o = input as { template?: unknown; data?: unknown };
  return {
    template: o.template,
    dataKeys: o.data && typeof o.data === "object" ? Object.keys(o.data as object) : undefined,
  };
}

function extractTemplates(output: unknown): unknown {
  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  }
  if (Array.isArray(output)) {
    for (const part of output) {
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") {
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        }
      }
    }
  }
  return output ?? null;
}
