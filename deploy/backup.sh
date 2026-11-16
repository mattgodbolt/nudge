#!/usr/bin/env bash
# Daily: consistent snapshot of the live database -> data/backups (keep 7) and the NAS (keep 14).
# Exit status is non-zero if the snapshot or the NAS copy fails, so cron mail / the log shows it.
#
# `backup.sh pre-update` (from update.sh, before every deploy) instead writes data/backups/pre-update-<time>.db and
# keeps the newest 3 of those, locally only. They are named apart from the nightly nudge-<time>.db files so that several
# deploys a day never push the nightly backups out of their retention.
set -euo pipefail
cd "$(dirname "$0")/.."
NAS_DIR="${NUDGE_BACKUP_DIR:-/nas/BackedUp/nudge}"
KEEP_LOCAL=7
KEEP_NAS=14
KEEP_PRE_UPDATE=3
mode="${1:-nightly}"
ts=$(date +%Y%m%d-%H%M%S)
log() { echo "$(date -Is) $*"; }

# Keep the newest N files matching a prefix in a directory.
prune() { ls -1t "$1"/"$2"-*.db 2>/dev/null | tail -n +"$(($3 + 1))" | while read -r f; do rm -f -- "$f" "$f-wal" "$f-shm"; done; }

case "$mode" in
  nightly) prefix=nudge ;;
  pre-update) prefix=pre-update ;;
  *)
    echo "usage: $0 [nightly|pre-update]" >&2
    exit 2
    ;;
esac
name="$prefix-$ts.db"

docker compose exec -T nudge node deploy/backup-db.mjs "/app/data/backups/$name"
log "snapshot data/backups/$name"

if [ "$mode" = pre-update ]; then
  prune data/backups pre-update "$KEEP_PRE_UPDATE"
  exit 0
fi
prune data/backups nudge "$KEEP_LOCAL"

# The NAS is an autofs/NFS soft mount: touching the path mounts it, and a dead NAS fails fast instead of hanging.
if [ -d "$NAS_DIR" ] && [ -w "$NAS_DIR" ]; then
  cp "data/backups/$name" "$NAS_DIR/$name.partial"
  mv "$NAS_DIR/$name.partial" "$NAS_DIR/$name"
  chmod 600 "$NAS_DIR/$name"
  prune "$NAS_DIR" nudge "$KEEP_NAS"
  log "copied to $NAS_DIR/$name"
  date -Is > data/backups/last-nas-success
else
  log "ERROR: $NAS_DIR is not writable; the snapshot is only in data/backups"
  exit 1
fi
