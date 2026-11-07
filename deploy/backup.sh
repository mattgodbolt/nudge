#!/usr/bin/env bash
# Daily: consistent snapshot of the live database -> data/backups (keep 7) and the NAS (keep 14).
# Exit status is non-zero if the snapshot or the NAS copy fails, so cron mail / the log shows it.
set -euo pipefail
cd "$(dirname "$0")/.."
NAS_DIR="${NUDGE_BACKUP_DIR:-/nas/BackedUp/nudge}"
KEEP_LOCAL=7
KEEP_NAS=14
ts=$(date +%Y%m%d-%H%M%S)
name="nudge-$ts.db"
log() { echo "$(date -Is) $*"; }

docker compose exec -T nudge node deploy/backup-db.mjs "/app/data/backups/$name"
log "snapshot data/backups/$name"

# Keep the newest N matching files in a directory.
prune() { ls -1t "$1"/nudge-*.db 2>/dev/null | tail -n +"$(($2 + 1))" | while read -r f; do rm -f -- "$f" "$f-wal" "$f-shm"; done; }
prune data/backups "$KEEP_LOCAL"

# The NAS is an autofs/NFS soft mount: touching the path mounts it, and a dead NAS fails fast instead of hanging.
if [ -d "$NAS_DIR" ] && [ -w "$NAS_DIR" ]; then
  cp "data/backups/$name" "$NAS_DIR/$name.partial"
  mv "$NAS_DIR/$name.partial" "$NAS_DIR/$name"
  chmod 600 "$NAS_DIR/$name"
  prune "$NAS_DIR" "$KEEP_NAS"
  log "copied to $NAS_DIR/$name"
  date -Is > data/backups/last-nas-success
else
  log "ERROR: $NAS_DIR is not writable; the snapshot is only in data/backups"
  exit 1
fi
