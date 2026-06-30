#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

RUN_ID="${1:-}"
SINCE="${2:-24h}"
LIMIT="${LIMIT:-500}"

if [[ -z "$RUN_ID" ]]; then
  echo "Usage: $0 <runId> [since]" >&2
  echo "  since: vercel logs --since window, e.g. 1h, 30m, 7d (default: 24h)" >&2
  exit 1
fi

# label:directory pairs for the three deployed Vercel projects
SERVICES=(
  "SERVER:server"
  "AGENT:agent"
  "PORTAL:mock-portal"
)

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pids=()
for entry in "${SERVICES[@]}"; do
  label="${entry%%:*}"
  dir="${entry#*:}"
  (
    cd "$ROOT/$dir"
    npx --yes vercel logs --no-branch --json --since "$SINCE" -n "$LIMIT" -q "$RUN_ID" \
      2>"$TMP_DIR/$label.err" | sed "s/^/${label}\t/" >"$TMP_DIR/$label.out"
  ) &
  pids+=("$!")
done

for pid in "${pids[@]}"; do
  wait "$pid"
done

for entry in "${SERVICES[@]}"; do
  label="${entry%%:*}"
  if grep -qi "error" "$TMP_DIR/$label.err" 2>/dev/null; then
    echo "[$label] vercel logs warning: $(tr '\n' ' ' <"$TMP_DIR/$label.err")" >&2
  fi
done

cat "$TMP_DIR"/*.out | node "$ROOT/trace-run.js"
