// Structured single-line JSON logger, mirror of agent/lib/log.ts so the mock
// portal's Vercel runtime logs share the same shape as the agent's.

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
