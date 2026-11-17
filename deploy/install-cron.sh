#!/usr/bin/env bash
# Idempotently installs the update and backup cron jobs for the current user.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -w "$dir/data" ] || [ "$(stat -c %u "$dir/data")" != "$(id -u)" ]; then
  echo "data/ must be owned by and writable for $(id -un) (uid $(id -u)) before the cron jobs can work;" >&2
  echo "see docs/DEPLOYING.md, 'A host user that is not uid 1000'." >&2
  exit 1
fi
# Quote each path for the shell cron runs the line with (printf %q), and escape % because cron turns a bare one into a newline.
q() { printf '%q' "$1" | sed 's/%/\\%/g'; }
update=$(q "$dir/deploy/update.sh")
backup=$(q "$dir/deploy/backup.sh")
updatelog=$(q "$dir/data/update.log")
backuplog=$(q "$dir/data/backup.log")
tmp=$(mktemp)
crontab -l 2>/dev/null | grep -v '# nudge' > "$tmp" || true
cat >> "$tmp" <<CRON
*/5 * * * * $update >> $updatelog 2>&1 # nudge update
15 3 * * * $backup >> $backuplog 2>&1 # nudge backup
CRON
crontab "$tmp"
rm -f "$tmp"
crontab -l | grep '# nudge'
