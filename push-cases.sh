#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/mock-portal"

node --env-file=.env.local scripts/push-cases.js
