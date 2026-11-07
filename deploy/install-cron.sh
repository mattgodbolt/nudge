#!/usr/bin/env bash
# Idempotently installs the update and backup cron jobs for the current user.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
tmp=$(mktemp)
crontab -l 2>/dev/null | grep -v '# nudge' > "$tmp" || true
cat >> "$tmp" <<CRON
*/5 * * * * $dir/deploy/update.sh >> $dir/data/update.log 2>&1 # nudge update
15 3 * * * $dir/deploy/backup.sh >> $dir/data/backup.log 2>&1 # nudge backup
CRON
crontab "$tmp"
rm -f "$tmp"
crontab -l | grep '# nudge'
