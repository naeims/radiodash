// Structured single-line JSON logger. One line per event so Vercel runtime logs
// stay greppable and filterable. A `runId` ties one agent run together across the
// agent function and the MCP function (passed via the x-run-id header).

type Level = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(extra: LogFields): Logger;
}

function emit(level: Level, scope: string, base: LogFields, event: string, fields?: LogFields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...base,
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function createLogger(scope: string, base: LogFields = {}): Logger {
  return {
    info: (event, fields) => emit("info", scope, base, event, fields),
    warn: (event, fields) => emit("warn", scope, base, event, fields),
    error: (event, fields) => emit("error", scope, base, event, fields),
    child: (extra) => createLogger(scope, { ...base, ...extra }),
  };
}

// Normalize an unknown error into loggable fields without dumping huge stacks unbounded.
export function errFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack?.split("\n").slice(0, 5).join("\n") };
  }
  return { error: String(err) };
}
