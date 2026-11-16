#!/usr/bin/env bash
# Daily: consistent snapshot of the live database -> data/backups (keep 7) and, if NUDGE_BACKUP_DIR is set, a second
# copy there (keep 14), ideally on another machine or disk. Exit status is non-zero if the snapshot or that copy fails,
# so cron mail / the log shows it. With NUDGE_BACKUP_DIR unset there is no second copy and that is not an error.
#
# `backup.sh pre-update` (from update.sh, before every deploy) instead writes data/backups/pre-update-<time>.db and
# keeps the newest 3 of those, locally only. They are named apart from the nightly nudge-<time>.db files so that several
# deploys a day never push the nightly backups out of their retention.
set -euo pipefail
# Everything this script creates is a copy of the database (tokens, keys): owner-only from the first byte, so the
# off-box copy is never world-readable, not even while it is still a .partial.
umask 077
cd "$(dirname "$0")/.."
OFFSITE_DIR="${NUDGE_BACKUP_DIR:-}"
KEEP_LOCAL=7
KEEP_OFFSITE=14
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

if [ -z "$OFFSITE_DIR" ]; then
  log "NUDGE_BACKUP_DIR is not set: no off-box copy (the snapshot is only in data/backups)"
  exit 0
fi
# Typically an autofs/NFS soft mount: touching the path mounts it, and a dead share fails fast instead of hanging.
if [ -d "$OFFSITE_DIR" ] && [ -w "$OFFSITE_DIR" ]; then
  cp "data/backups/$name" "$OFFSITE_DIR/$name.partial"
  mv "$OFFSITE_DIR/$name.partial" "$OFFSITE_DIR/$name"
  chmod 600 "$OFFSITE_DIR/$name"
  prune "$OFFSITE_DIR" nudge "$KEEP_OFFSITE"
  log "copied to $OFFSITE_DIR/$name"
  date -Is > data/backups/last-offsite-success
else
  log "ERROR: $OFFSITE_DIR is not writable; the snapshot is only in data/backups"
  exit 1
fi
