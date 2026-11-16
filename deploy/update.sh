#!/usr/bin/env bash
# Every few minutes (cron): if origin/main has new commits, back up, build (the unit tests gate the build), restart,
# and roll back to the previous image if the new one does not become healthy. A bad commit is remembered and not retried.
#
# Every failure exits non-zero with an ERROR line in the log (data/update.log under cron); unexpected ones are caught by
# the ERR trap. deploy/test-update.sh rehearses all of this against fake git remotes and a fake docker.
#
# The body is a function called on the last line, so bash has read all of it before `git merge` replaces this file.
set -Eeuo pipefail

log() { echo "$(date -Is) $*"; }

main() {
  cd "$(dirname "$0")/.."
  exec 9>data/.update.lock
  flock -n 9 || exit 0
  trap 'log "ERROR: update.sh failed (exit $?) at line $LINENO: $BASH_COMMAND"' ERR

  git fetch -q origin main
  local remote local_sha
  remote=$(git rev-parse origin/main)
  local_sha=$(git rev-parse HEAD)
  [ "$remote" = "$local_sha" ] && exit 0
  [ "$remote" = "$(cat data/.failed-sha 2>/dev/null || true)" ] && exit 0

  log "updating ${local_sha:0:8} -> ${remote:0:8}"
  if ! git merge -q --ff-only origin/main; then
    # Someone rewrote main, or the checkout has local commits: retrying every five minutes cannot fix that.
    log "ERROR: origin/main (${remote:0:8}) is not a fast-forward of ${local_sha:0:8}; fix the checkout by hand"
    echo "$remote" > data/.failed-sha
    exit 1
  fi

  # Cheap insurance: new code may migrate the schema on start. Remember the snapshot only if this run really made one,
  # because a rollback may need it: an older build refuses to start against a schema newer than it understands.
  # Pre-update snapshots have their own name and retention (backup.sh pre-update), so frequent deploys never push the
  # nightly backups out.
  newest_backup() { ls -1t data/backups/pre-update-*.db 2>/dev/null | head -1 || true; }
  local backup_before pre_backup
  backup_before=$(newest_backup)
  deploy/backup.sh pre-update || log "WARN: backup.sh reported a problem; checking for a fresh local snapshot"
  pre_backup=$(newest_backup)
  [ "$pre_backup" = "$backup_before" ] && pre_backup=""
  # Without a snapshot taken now, a bad migration could not be undone: put git back (so the next run retries) and stop.
  # Only while the app is up: backup.sh runs inside the container, and a crash-looping app must still be fixable (the
  # app also snapshots by itself before migrating, so that case is covered).
  if [ -z "$pre_backup" ] && [ -n "$(docker compose ps --status running -q nudge 2>/dev/null)" ]; then
    log "ERROR: no pre-update snapshot was made; skipping this update (will retry)"
    git reset -q --hard "$local_sha"
    exit 1
  fi

  docker tag nudge:latest nudge:prev 2>/dev/null || true
  # A stalled download (e.g. compiling better-sqlite3) must not block every later update, so the build has a deadline.
  # The image has no .git, so hand it the commit for Settings > About.
  GIT_SHA=$(git rev-parse --short=8 HEAD)
  export GIT_SHA
  if ! timeout 25m docker compose build; then
    log "ERROR: build or tests FAILED (or timed out) for ${remote:0:8}; keeping the running version"
    echo "$remote" > data/.failed-sha
    git reset -q --hard "$local_sha"
    exit 1
  fi
  # If the container cannot even be started, the health check below fails and the rollback runs.
  docker compose up -d || log "WARN: docker compose up failed; waiting for the health check anyway"

  local status
  for _ in $(seq 1 30); do
    status=$(docker inspect -f '{{.State.Health.Status}}' nudge 2>/dev/null || echo none)
    if [ "$status" = healthy ]; then
      log "updated to ${remote:0:8}"
      rm -f data/.failed-sha
      prune_images
      exit 0
    fi
    sleep 3
  done

  log "ERROR: new version not healthy; rolling back to ${local_sha:0:8}"
  echo "$remote" > data/.failed-sha
  docker tag nudge:prev nudge:latest
  git reset -q --hard "$local_sha"
  docker compose up -d --force-recreate --no-build || log "WARN: docker compose up failed during the rollback"

  for _ in $(seq 1 20); do
    status=$(docker inspect -f '{{.State.Health.Status}}' nudge 2>/dev/null || echo none)
    if [ "$status" = healthy ]; then
      log "rolled back to ${local_sha:0:8}, which is healthy"
      exit 1
    fi
    sleep 3
  done
  # The old build will not start if the new one already migrated the database. Put the pre-update data back (this loses
  # whatever changed since that snapshot, a few minutes at most).
  if [ -n "$pre_backup" ]; then
    log "ERROR: rolled-back build is not healthy either; restoring the pre-update snapshot $pre_backup"
    docker compose stop nudge
    cp "$pre_backup" data/nudge.db
    rm -f data/nudge.db-wal data/nudge.db-shm
    docker compose up -d --no-build
  else
    log "ERROR: rolled-back build is not healthy and there is no pre-update snapshot; check data/backups"
  fi
  exit 1
}

# Every deploy leaves the previous `latest` untagged, plus build cache; without this the disk fills up eventually.
# Only dangling images (no tag, no container) go, so nudge:prev, the rollback target, stays. Never fails a deploy.
prune_images() {
  docker image prune -f > /dev/null || log "WARN: docker image prune failed"
  docker builder prune -f --filter until=168h > /dev/null || log "WARN: docker builder prune failed"
}

main "$@"
