#!/usr/bin/env bash
# Rehearses deploy/update.sh and deploy/backup.sh in a throwaway sandbox: a local bare "origin", a checkout to deploy,
# and fake `docker`, `sleep` and `date` commands on PATH. Nothing touches the real checkout, Docker or any host.
#
#   deploy/test-update.sh        (exits non-zero if any check fails)
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REAL_DATE="$(command -v date)"
REAL_MV="$(command -v mv)"
REAL_SLEEP="$(command -v sleep)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/nudge-update-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
BIN="$SANDBOX/bin"
STATE="$SANDBOX/state"
WORK="$SANDBOX/work"
DEV="$SANDBOX/dev"
mkdir -p "$BIN" "$STATE"

failures=0
pass() { echo "  ok   $*"; }
fail() {
  echo "  FAIL $*"
  failures=$((failures + 1))
}
check() { # check <description> <command...>
  local what="$1"
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}

# ---- fakes --------------------------------------------------------------------------------------------------------

# docker: records every call; behaviour is steered by files in $STATE (build, backup, prune: "fail" to fail;
# build-hangs: how many builds in a row go silent and never finish; build "slow": a build that keeps printing but never
# finishes; health-new / health-old: what the health check reports for the new and the previous image).
cat > "$BIN/docker" <<EOF
#!/usr/bin/env bash
STATE="$STATE"
WORK="$WORK"
REAL_SLEEP="$REAL_SLEEP"
EOF
cat >> "$BIN/docker" <<'EOF'
echo "docker $*" >> "$STATE/calls"
flag() { [ "$(cat "$STATE/$1" 2>/dev/null)" = fail ]; }
case "$1 ${2:-}" in
  "compose ps") [ -f "$STATE/running" ] && echo c0ffee ;;
  "compose exec")
    flag backup && exit 1
    dest="${*: -1}" # /app/data/backups/<name>
    n=$(($(cat "$STATE/clock" 2>/dev/null || echo 0) + 1))
    echo "$n" > "$STATE/clock"
    touch -d "@$((1800000000 + n * 60))" "$WORK/data/${dest#/app/data/}"
    chmod 644 "$WORK/data/${dest#/app/data/}" # as the container's default umask would leave it
    ;;
  "compose build")
    flag build && exit 1
    hangs=$(cat "$STATE/build-hangs" 2>/dev/null || echo 0)
    if [ "$hangs" -gt 0 ]; then
      echo $((hangs - 1)) > "$STATE/build-hangs"
      echo "Step 7/12 : RUN npm run build"
      # A child, which would outlive the build if only this process were stopped.
      "$REAL_SLEEP" 600 &
      echo "$!" >> "$STATE/hung-pids"
      wait
    fi
    if [ "$(cat "$STATE/build" 2>/dev/null)" = slow ]; then
      while :; do echo "still downloading"; "$REAL_SLEEP" 0.2; done
    fi
    echo new > "$STATE/image"
    ;;
  "compose up") touch "$STATE/running" ;;
  "compose stop") rm -f "$STATE/running" ;;
  "tag nudge:prev") echo old > "$STATE/image" ;;
  "tag nudge:latest") ;;
  "inspect -f") cat "$STATE/health-$(cat "$STATE/image" 2>/dev/null || echo old)" 2>/dev/null || echo none ;;
  "image prune" | "builder prune") flag prune && exit 1 ;;
  *) echo "fake docker: unexpected: $*" >&2 ; exit 99 ;;
esac
exit 0
EOF
# sleep: barely sleeps, so health-check waits are instant but update.sh's build watchdog does not spin.
printf '#!/usr/bin/env bash\nexec %q 0.02\n' "$REAL_SLEEP" > "$BIN/sleep"
# date: real, except that backup.sh's timestamp ticks a counter so snapshots taken in the same second differ.
cat > "$BIN/date" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "+%Y%m%d-%H%M%S" ]; then
  n=\$((\$(cat "$STATE/ts" 2>/dev/null || echo 0) + 1)); echo "\$n" > "$STATE/ts"
  printf '20260101-%06d\n' "\$n"
else
  exec "$REAL_DATE" "\$@"
fi
EOF
# mv: real, but notes the mode of an off-box .partial copy at the moment it is renamed into place.
cat > "$BIN/mv" <<EOF
#!/usr/bin/env bash
case "\$1" in *.partial) stat -c %a "\$1" > "$STATE/partial-mode" ;; esac
exec "$REAL_MV" "\$@"
EOF
chmod +x "$BIN"/*

# ---- repositories -------------------------------------------------------------------------------------------------

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$DEV" 2> /dev/null
mkdir -p "$DEV/deploy"
cp "$REPO/deploy/update.sh" "$REPO/deploy/backup.sh" "$DEV/deploy/"
echo 'data/' > "$DEV/.gitignore"
echo 0 > "$DEV/version"
git -C "$DEV" add -A
git -C "$DEV" commit -q -m initial
git -C "$DEV" push -q origin main
git clone -q "$SANDBOX/origin.git" "$WORK"
mkdir -p "$WORK/data/backups"

push_commit() {
  echo "$(($(cat "$DEV/version") + 1))" > "$DEV/version"
  git -C "$DEV" commit -q -am "version $(cat "$DEV/version")"
  git -C "$DEV" push -q origin main
}
remote_sha() { git -C "$SANDBOX/origin.git" rev-parse main; }
head_sha() { git -C "$WORK" rev-parse HEAD; }

OUT="$SANDBOX/out"
RC=0
run_update() {
  : > "$STATE/calls"
  PATH="$BIN:$PATH" NUDGE_BACKUP_DIR="$SANDBOX/nas" NUDGE_BUILD_STALL_SECS=2 "$WORK/deploy/update.sh" > "$OUT" 2>&1
  RC=$?
}
logged() { grep -q -- "$1" "$OUT"; }
called() { grep -q -- "$1" "$STATE/calls"; }
count() { find "$WORK/data/backups" -name "$1" | wc -l; }
builds() { grep -c 'compose build' "$STATE/calls"; }
none_alive() { # none_alive <pidfile>: every process it lists has gone
  local p
  [ -f "$1" ] || return 0
  while read -r p; do kill -0 "$p" 2>/dev/null && return 1; done < "$1"
  return 0
}
reset_fakes() {
  rm -f "$STATE/build" "$STATE/build-hangs" "$STATE/hung-pids" "$STATE/backup" "$STATE/prune"
  rm -f "$WORK/data/.failed-sha"
}

# A running app with an old, healthy image and a week of nightly backups.
touch "$STATE/running"
echo old > "$STATE/image"
echo healthy > "$STATE/health-old"
echo healthy > "$STATE/health-new"
for d in 1 2 3 4 5 6 7; do touch -d "@$((1700000000 + d * 86400))" "$WORK/data/backups/nudge-2025110$d-031500.db"; done

# ---- scenarios ----------------------------------------------------------------------------------------------------

echo "nothing new"
run_update
check "exits 0" [ "$RC" = 0 ]
check "stays quiet" [ ! -s "$OUT" ]
check "does not touch docker" [ ! -s "$STATE/calls" ]

echo "a good commit"
push_commit
run_update
check "exits 0" [ "$RC" = 0 ]
check "checks out the new commit" [ "$(head_sha)" = "$(remote_sha)" ]
check "logs the update" logged "updated to"
check "takes a pre-update snapshot" [ "$(count 'pre-update-*.db')" = 1 ]
check "keeps the old image as nudge:prev" called "tag nudge:latest nudge:prev"
check "prunes dangling images and old build cache" called "image prune -f"
check "prunes old build cache" called "builder prune -f --filter until=168h"

echo "many deploys in a day"
for _ in 1 2 3 4 5; do
  push_commit
  run_update
done
check "the last one succeeds" [ "$RC" = 0 ]
check "keeps only 3 pre-update snapshots" [ "$(count 'pre-update-*.db')" = 3 ]
check "leaves all 7 nightly backups alone" [ "$(count 'nudge-2025110[1-7]-031500.db')" = 7 ]

echo "a commit whose build (or tests) fail"
before=$(head_sha)
push_commit
echo fail > "$STATE/build"
run_update
check "exits non-zero" [ "$RC" != 0 ]
check "logs an ERROR" logged "ERROR: build or tests FAILED"
check "puts the checkout back" [ "$(head_sha)" = "$before" ]
check "remembers the bad commit" [ "$(cat "$WORK/data/.failed-sha")" = "$(remote_sha)" ]
check "does not restart anything" bash -c "! grep -q 'compose up' '$STATE/calls'"
check "builds only once (a real failure is not retried)" [ "$(builds)" = 1 ]
check "and does not say it is retrying" bash -c "! grep -q retrying '$OUT'"
run_update
check "does not retry the bad commit" [ "$RC" = 0 ]
check "and says nothing more about it" [ ! -s "$OUT" ]
reset_fakes

echo "a build that goes silent once (#29)"
push_commit
echo 1 > "$STATE/build-hangs"
run_update
check "exits 0" [ "$RC" = 0 ]
check "notices the stall" logged "WARN: no build output for 2s; stopping the build"
check "says it is retrying" logged "WARN: build stalled or timed out for .*; retrying once"
check "builds twice" [ "$(builds)" = 2 ]
check "stops everything the stalled build started" none_alive "$STATE/hung-pids"
check "deploys the commit" [ "$(head_sha)" = "$(remote_sha)" ]
check "does not mark it bad" [ ! -f "$WORK/data/.failed-sha" ]
reset_fakes

echo "a build that goes silent twice"
before=$(head_sha)
push_commit
echo 2 > "$STATE/build-hangs"
echo old > "$STATE/image"
run_update
check "exits non-zero" [ "$RC" != 0 ]
check "says it is retrying" logged "retrying once"
check "gives up after the retry" [ "$(builds)" = 2 ]
check "logs an ERROR" logged "ERROR: build or tests FAILED"
check "stops everything both builds started" none_alive "$STATE/hung-pids"
check "puts the checkout back" [ "$(head_sha)" = "$before" ]
check "remembers the bad commit" [ "$(cat "$WORK/data/.failed-sha")" = "$(remote_sha)" ]
check "does not restart anything" bash -c "! grep -q 'compose up' '$STATE/calls'"
check "leaves the old container running" [ -f "$STATE/running" ]
check "on the old image, with no new one built" [ "$(cat "$STATE/image")" = old ]
check "keeps the stalled build's output for a post-mortem" grep -q "Step 7/12" "$WORK/data/build.log"
reset_fakes

echo "a build that keeps printing but runs past the deadline"
push_commit
echo slow > "$STATE/build"
NUDGE_BUILD_TIMEOUT=1s run_update
check "exits non-zero" [ "$RC" != 0 ]
check "is not taken for a stall" bash -c "! grep -q 'no build output' '$OUT'"
check "is retried once" [ "$(builds)" = 2 ]
check "says it is retrying" logged "retrying once"
check "remembers the bad commit" [ "$(cat "$WORK/data/.failed-sha")" = "$(remote_sha)" ]
reset_fakes

echo "a commit that starts but never becomes healthy"
before=$(head_sha)
push_commit
echo unhealthy > "$STATE/health-new"
run_update
check "exits non-zero" [ "$RC" != 0 ]
check "logs an ERROR" logged "ERROR: new version not healthy"
check "restores the previous image" called "tag nudge:prev nudge:latest"
check "restarts it" called "compose up -d --force-recreate --no-build"
check "says the rollback is healthy" logged "rolled back to"
check "puts the checkout back" [ "$(head_sha)" = "$before" ]
check "remembers the bad commit" [ "$(cat "$WORK/data/.failed-sha")" = "$(remote_sha)" ]
echo healthy > "$STATE/health-new"
reset_fakes

echo "a rollback that is not healthy either (the new build migrated the schema)"
push_commit
echo unhealthy > "$STATE/health-new"
echo unhealthy > "$STATE/health-old"
echo 'live data' > "$WORK/data/nudge.db"
run_update
check "exits non-zero" [ "$RC" != 0 ]
check "logs the restore" logged "ERROR: rolled-back build is not healthy either; restoring"
check "copies the pre-update snapshot over the database" [ ! -s "$WORK/data/nudge.db" ]
echo healthy > "$STATE/health-new"
echo healthy > "$STATE/health-old"
reset_fakes

echo "no snapshot could be made while the app is running"
before=$(head_sha)
push_commit
echo fail > "$STATE/backup"
run_update
check "exits non-zero" [ "$RC" != 0 ]
check "logs an ERROR" logged "ERROR: no pre-update snapshot was made"
check "puts the checkout back, to retry" [ "$(head_sha)" = "$before" ]
check "does not build" bash -c "! grep -q 'compose build' '$STATE/calls'"
check "does not mark the commit bad" [ ! -f "$WORK/data/.failed-sha" ]
reset_fakes
run_update
check "the retry goes through" [ "$RC" = 0 ]

echo "a failing image prune"
push_commit
echo fail > "$STATE/prune"
run_update
check "does not fail the deploy" [ "$RC" = 0 ]
check "is logged as a warning" logged "WARN: docker image prune failed"
reset_fakes

echo "an unreachable origin"
git -C "$WORK" remote set-url origin "$SANDBOX/missing.git"
run_update
check "exits non-zero" [ "$RC" != 0 ]
check "logs an ERROR naming the failed command" logged "ERROR: update.sh failed (exit .*git fetch"
git -C "$WORK" remote set-url origin "$SANDBOX/origin.git"

echo "a rewritten main (not a fast-forward)"
before=$(head_sha)
git -C "$DEV" reset -q --hard HEAD~1
echo 1000 > "$DEV/version"
git -C "$DEV" commit -q -am rewritten
git -C "$DEV" push -q -f origin main # the sandbox's own origin only
run_update
check "exits non-zero" [ "$RC" != 0 ]
check "logs an ERROR" logged "ERROR: origin/main .* is not a fast-forward"
check "leaves the checkout alone" [ "$(head_sha)" = "$before" ]
run_update
check "does not retry it every five minutes" [ "$RC" = 0 ]
reset_fakes
git -C "$WORK" reset -q --hard "$(remote_sha)"

echo "another run already holds the lock"
push_commit
before=$(head_sha)
exec 8> "$WORK/data/.update.lock"
flock -n 8
run_update
check "exits 0 at once" [ "$RC" = 0 ]
check "does nothing" [ "$(head_sha)" = "$before" ]
exec 8>&-
run_update
check "the next run deploys" [ "$(head_sha)" = "$(remote_sha)" ]

echo "nightly backup"
: > "$STATE/calls"
mkdir -p "$SANDBOX/nas"
(cd "$WORK" && PATH="$BIN:$PATH" NUDGE_BACKUP_DIR="$SANDBOX/nas" deploy/backup.sh > "$OUT" 2>&1)
check "succeeds" [ $? = 0 ]
check "still keeps 7 nightly snapshots" [ "$(count 'nudge-*.db')" = 7 ]
check "leaves the pre-update snapshots alone" [ "$(count 'pre-update-*.db')" = 3 ]
check "copies to the off-box directory" [ "$(find "$SANDBOX/nas" -name 'nudge-*.db' | wc -l)" = 1 ]
check "never leaves the off-box copy readable by others, even before it is renamed" \
  [ "$(cat "$STATE/partial-mode")" = 600 ]
(cd "$WORK" && PATH="$BIN:$PATH" NUDGE_BACKUP_DIR= deploy/backup.sh > "$OUT" 2>&1)
check "with no off-box directory configured it still succeeds" [ $? = 0 ]
check "and says so" grep -q "NUDGE_BACKUP_DIR is not set" "$OUT"
(cd "$WORK" && PATH="$BIN:$PATH" NUDGE_BACKUP_DIR="$SANDBOX/nas" deploy/backup.sh bogus > "$OUT" 2>&1)
check "rejects an unknown mode" [ $? = 2 ]

echo "backup-db.mjs (the real script, against a scratch database)"
(cd "$REPO" && node -e "const D = require('better-sqlite3'); const db = new D(process.argv[1]);
  db.exec('CREATE TABLE comments (id TEXT)'); db.close();" "$SANDBOX/live.db")
(umask 022 && cd "$REPO" && NUDGE_DB="$SANDBOX/live.db" node deploy/backup-db.mjs "$SANDBOX/bk/new/copy.db" > "$OUT" 2>&1)
check "succeeds" [ $? = 0 ]
check "creates the backups directory owner-only, even under a permissive umask" \
  [ "$(stat -c %a "$SANDBOX/bk/new")" = 700 ]
check "and the copy" [ "$(stat -c %a "$SANDBOX/bk/new/copy.db")" = 600 ]

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) FAILED"
  exit 1
fi
echo "all deploy checks passed"
