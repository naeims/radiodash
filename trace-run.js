#!/usr/bin/env node
// Merges tab-prefixed `vercel logs --json` lines from multiple services into one
// chronological, color-tagged stream. Each input line is "LABEL\t<json>".

const readline = require("readline");

const COLORS = {
  SERVER: "\x1b[36m",
  AGENT: "\x1b[32m",
  PORTAL: "\x1b[33m",
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const OMIT_KEYS = ["ts", "level", "scope", "event", "runId"];

const events = [];

function omit(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) out[k] = obj[k];
  }
  return out;
}

function handleEntry(label, entry) {
  const subs = entry.logs && entry.logs.length
    ? entry.logs
    : entry.message
      ? [{ level: entry.level, message: entry.message }]
      : [];

  for (const sub of subs) {
    let parsed = null;
    try {
      parsed = JSON.parse(sub.message);
    } catch {
      // not one of our structured log lines
    }

    if (parsed && typeof parsed === "object" && parsed.ts) {
      events.push({
        ts: new Date(parsed.ts).getTime(),
        label,
        scope: parsed.scope || entry.source || "?",
        level: parsed.level || sub.level,
        event: parsed.event || "",
        rest: omit(parsed, OMIT_KEYS),
      });
    } else if (sub.message) {
      events.push({
        ts: entry.timestamp,
        label,
        scope: entry.source || "?",
        level: sub.level,
        event: sub.message,
        rest: null,
      });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const tabIdx = line.indexOf("\t");
  if (tabIdx === -1) return;
  const label = line.slice(0, tabIdx);
  let entry;
  try {
    entry = JSON.parse(line.slice(tabIdx + 1));
  } catch {
    return;
  }
  handleEntry(label, entry);
});

rl.on("close", () => {
  if (events.length === 0) {
    console.error("No matching log lines found for that runId in the given time window.");
    process.exit(0);
  }

  events.sort((a, b) => a.ts - b.ts);

  const width = Math.max(...Object.keys(COLORS).map((k) => k.length));
  for (const e of events) {
    const color = COLORS[e.label] || "";
    const tag = `${color}${BOLD}[${e.label.padEnd(width)}]${RESET}`;
    const tsStr = new Date(e.ts).toISOString();
    const levelTag = e.level === "error" ? `${RED}${BOLD}ERROR${RESET} ` : "";
    const restStr = e.rest && Object.keys(e.rest).length ? ` ${JSON.stringify(e.rest)}` : "";
    console.log(`${tag} ${tsStr} ${levelTag}${e.scope}/${e.event}${restStr}`);
  }
});
