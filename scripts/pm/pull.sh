#!/usr/bin/env bash
# Pulls aggregate usage data from the deployed instance and writes a sanitised copy outside the repo.
# Usage: scripts/pm/pull.sh [ssh-host]   (default: phoenix). Output: ~/nudge-pm/data/<date>.json, ~/nudge-pm/issues.json
set -euo pipefail
host="${1:-phoenix}"
here="$(cd "$(dirname "$0")" && pwd)"
out="${NUDGE_PM_DIR:-$HOME/nudge-pm}"
mkdir -p "$out/data" "$out/reports"
day="$(date +%F)"
ssh "$host" 'cd nudge && PM_TZ=America/Chicago docker compose exec -T -e PM_TZ -w /app nudge node --input-type=module' < "$here/fetch.mjs" \
  | node "$here/sanitise.mjs" > "$out/data/$day.json"
gh issue list --state all --limit 200 --json number,title,state,labels,createdAt,closedAt > "$out/issues.json"
echo "$out/data/$day.json"
