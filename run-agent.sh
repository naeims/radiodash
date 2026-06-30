#!/usr/bin/env bash
set -euo pipefail

AGENT_URL="https://agent-rho-virid.vercel.app/api/agent/run"

ENV_FILE="$(dirname "$0")/agent/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  set -a; source "$ENV_FILE"; set +a
fi

AUTH_TOKEN="${CRON_SECRET:?CRON_SECRET is not set in agent/.env.local}"

curl -s -X POST "$AGENT_URL" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  "$@"
