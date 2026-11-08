#!/usr/bin/env bash
# Every few minutes (cron): if origin/main has new commits, back up, build (the unit tests gate the build), restart,
# and roll back to the previous image if the new one does not become healthy. A bad commit is remembered and not retried.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>data/.update.lock
flock -n 9 || exit 0
log() { echo "$(date -Is) $*"; }

git fetch -q origin main
remote=$(git rev-parse origin/main)
local_sha=$(git rev-parse HEAD)
[ "$remote" = "$local_sha" ] && exit 0
[ "$remote" = "$(cat data/.failed-sha 2>/dev/null || true)" ] && exit 0

log "updating ${local_sha:0:8} -> ${remote:0:8}"
git merge -q --ff-only origin/main

# Cheap insurance: new code may migrate the schema on start. Remember the snapshot only if this run really made one,
# because a rollback may need it: an older build refuses to start against a schema newer than it understands.
newest_backup() { ls -1t data/backups/nudge-*.db 2>/dev/null | head -1 || true; }
backup_before=$(newest_backup)
deploy/backup.sh || log "WARN: pre-update backup failed (continuing)"
pre_backup=$(newest_backup)
[ "$pre_backup" = "$backup_before" ] && pre_backup=""

docker tag nudge:latest nudge:prev 2>/dev/null || true
# A stalled download (e.g. compiling better-sqlite3) must not block every later update, so the build has a deadline.
# The image has no .git, so hand it the commit for Settings > About.
GIT_SHA=$(git rev-parse --short=8 HEAD)
export GIT_SHA
if ! timeout 25m docker compose build; then
  log "build or tests FAILED (or timed out) for ${remote:0:8}; keeping the running version"
  echo "$remote" > data/.failed-sha
  git reset -q --hard "$local_sha"
  exit 1
fi
docker compose up -d

for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' nudge 2>/dev/null || echo none)
  [ "$status" = healthy ] && { log "updated to ${remote:0:8}"; rm -f data/.failed-sha; exit 0; }
  sleep 3
done

log "new version not healthy; rolling back to ${local_sha:0:8}"
echo "$remote" > data/.failed-sha
docker tag nudge:prev nudge:latest
git reset -q --hard "$local_sha"
docker compose up -d --force-recreate --no-build

for _ in $(seq 1 20); do
  status=$(docker inspect -f '{{.State.Health.Status}}' nudge 2>/dev/null || echo none)
  [ "$status" = healthy ] && exit 1
  sleep 3
done
# The old build will not start if the new one already migrated the database. Put the pre-update data back (this loses
# whatever changed since that snapshot, a few minutes at most).
if [ -n "$pre_backup" ]; then
  log "rolled-back build is not healthy either; restoring the pre-update snapshot $pre_backup"
  docker compose stop nudge
  cp "$pre_backup" data/nudge.db
  rm -f data/nudge.db-wal data/nudge.db-shm
  docker compose up -d --no-build
else
  log "ERROR: rolled-back build is not healthy and there is no pre-update snapshot; check data/backups"
fi
exit 1
