#!/usr/bin/env bash
# Every few minutes (cron): if origin/main has new commits, back up, build (the unit tests gate the build), restart,
# and roll back to the previous image if the new one does not become healthy. A bad commit is remembered and not retried.
#
# Every failure exits non-zero with an ERROR line in the log (data/update.log under cron); unexpected ones are caught by
# the ERR trap. deploy/test-update.sh rehearses all of this against fake git remotes and a fake docker.
#
# The build is stopped if it prints nothing for NUDGE_BUILD_STALL_SECS (default 300) or runs past NUDGE_BUILD_TIMEOUT
# (default 25m, any `timeout` duration). Either is retried once; only then is the commit marked bad.
#
# The body is a function called on the last line, so bash has read all of it before `git merge` replaces this file.
set -Eeuo pipefail

log() { echo "$(date -Is) $*"; }

main() {
  cd "$(dirname "$0")/.."
  # The lock, the logs and the rollback's read of the 0600 snapshots all need data/ to belong to the cron user.
  if [ ! -w data ] || [ "$(stat -c %u data)" != "$(id -u)" ]; then
    log "ERROR: data/ must be owned by and writable for $(id -un) (uid $(id -u)); see docs/DEPLOYING.md, 'A host user that is not uid 1000'"
    exit 1
  fi
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
  # The image has no .git, so hand it the commit for Settings > Version.
  GIT_SHA=$(git rev-parse --short=8 HEAD)
  export GIT_SHA
  # Builds on the deploy host occasionally sit idle until killed (#29). That is transient, so a stalled or timed-out
  # build is tried once more before the commit is marked bad. A build or test that really fails exits by itself, and
  # is not retried: it would fail the same way again.
  local build_rc
  build_rc=0
  build_image 1 || build_rc=$?
  if [ "$build_rc" = 124 ]; then
    log "WARN: build stalled or timed out for ${remote:0:8}; retrying once"
    build_rc=0
    build_image 2 || build_rc=$?
  fi
  if [ "$build_rc" != 0 ]; then
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

# build_image <attempt>: `docker compose build` with a deadline and a stall watchdog. Its output goes to data/build.log
# (kept, so a hang leaves evidence) and then into this log. Returns 124 if the build stalled or hit the deadline,
# otherwise the build's own exit status.
build_image() {
  local out=data/build.log stall=${NUDGE_BUILD_STALL_SECS:-300} pid size last_size=-1 last_change=$SECONDS rc=0
  local stalled=""
  log "building (attempt $1; output in $out)"
  # timeout puts itself and everything under it in a process group of its own (pgid = its pid), which is what lets
  # stop_build reach docker and its children; -k makes the deadline escalate to SIGKILL as well.
  timeout -k 1m "${NUDGE_BUILD_TIMEOUT:-25m}" docker compose build > "$out" 2>&1 < /dev/null &
  pid=$!
  while kill -0 "$pid" 2> /dev/null; do
    size=$(stat -c %s "$out" 2> /dev/null || echo 0)
    if [ "$size" != "$last_size" ]; then
      last_size=$size
      last_change=$SECONDS
    elif [ $((SECONDS - last_change)) -ge "$stall" ]; then
      log "WARN: no build output for ${stall}s; stopping the build"
      stalled=1
      stall_snapshot
      stop_build "$pid"
      break
    fi
    sleep 5
  done
  wait "$pid" || rc=$?
  cat "$out" 2> /dev/null || true
  [ -n "$stalled" ] && return 124
  # 137: the deadline's TERM was ignored and -k had to KILL it, which is a hang too.
  [ "$rc" = 137 ] && return 124
  return "$rc"
}

# stall_snapshot: record what the host and Docker look like while a build is hung, so a stall (#29) leaves an
# explanation instead of only a timeout. Written to data/stall-<time>.log; every probe is bounded and none can fail
# the deploy.
stall_snapshot() {
  local f="data/stall-$(date +%Y%m%dT%H%M%S).log"
  {
    echo "== uptime / memory"; uptime; free -m
    echo "== pressure (io / memory / cpu)"; tail /proc/pressure/io /proc/pressure/memory /proc/pressure/cpu 2> /dev/null
    echo "== zfs arc"; grep -E '^(size|c|c_max|memory_throttle_count) ' /proc/spl/kstat/zfs/arcstats 2> /dev/null
    echo "== processes in uninterruptible sleep"; ps -eo stat,pid,ppid,wchan:24,etime,args 2> /dev/null | awk 'NR==1 || $1 ~ /^D/'
    echo "== build-related processes"; ps -eo stat,pid,ppid,wchan:24,etime,args 2> /dev/null | grep -E '[d]ocker|[b]uildkit|[v]itest|[n]pm |[n]ode ' | cut -c1-200
    echo "== docker"; timeout 20 docker ps -a --format '{{.ID}} {{.Status}} {{.Names}}' 2>&1 | head -20
    echo "== tail of the build log"; tail -n 15 data/build.log 2> /dev/null
  } > "$f" 2>&1 || true
  log "stall diagnostics saved to $f"
}

# stop_build <pid>: TERM the build's process group, then KILL it if it is still there a minute later.
stop_build() {
  kill -TERM -- "-$1" 2> /dev/null || kill -TERM "$1" 2> /dev/null || true
  for _ in $(seq 1 12); do
    kill -0 "$1" 2> /dev/null || return 0
    sleep 5
  done
  log "WARN: the build ignored SIGTERM; killing it"
  kill -KILL -- "-$1" 2> /dev/null || kill -KILL "$1" 2> /dev/null || true
}

# Every deploy leaves the previous `latest` untagged, plus build cache; without this the disk fills up eventually.
# Only dangling images (no tag, no container) go, so nudge:prev, the rollback target, stays. Never fails a deploy.
prune_images() {
  docker image prune -f > /dev/null || log "WARN: docker image prune failed"
  docker builder prune -f --filter until=168h > /dev/null || log "WARN: docker builder prune failed"
}

main "$@"
