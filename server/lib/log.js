// Structured single-line JSON logger for the docx server, matching the shape used
// by the agent and mock-portal projects so all three streams grep the same way.

function emit(level, scope, event, fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

function createLogger(scope, base = {}) {
  return {
    info: (event, fields) => emit("info", scope, event, { ...base, ...fields }),
    warn: (event, fields) => emit("warn", scope, event, { ...base, ...fields }),
    error: (event, fields) => emit("error", scope, event, { ...base, ...fields }),
    child: (extra) => createLogger(scope, { ...base, ...extra }),
  };
}

module.exports = { createLogger };
