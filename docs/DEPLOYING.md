# Deploying

Nudge is one Node process and one SQLite file, so the simplest deployment is `npm start` on the machine you use, bound
to loopback, with nothing to configure. To reach it from a phone or another machine, the supported way is a box of your
own running it in Docker behind a Cloudflare Tunnel and Cloudflare Access, with automatic updates and nightly backups;
that setup is described in full below. Cloudflare is one way to do it, not a requirement. Back to the
[README](../README.md).

## Ways to run it

- **On your own machine, loopback only.** `npm start` serves the production build on `http://127.0.0.1:4517`. No
  Cloudflare, no `NUDGE_ACCESS_*` variables, nothing to set up beyond the keys you want. It has no login of its own,
  so keep it on loopback and do not expose the port.
- **On another box, reached over SSH.** Run it there (with `npm start`, or with Docker as below but leaving the Access
  variables empty) and forward the port: `ssh -L 4517:127.0.0.1:4517 <box>`, then open `http://127.0.0.1:4517`. The
  request arrives with a loopback `Host`, so it is treated as local. This suits a laptop; a phone needs the next option.
- **From anywhere, phone included: Cloudflare Tunnel and Access.** Cloudflare Access is the only sign-in Nudge
  verifies (see the [security model](SECURITY-MODEL.md)). Another reverse proxy or VPN reaching the port with its own
  hostname is refused by the `Host` check, and one that rewrote `Host` to loopback would bypass every check, so do not
  put Nudge behind one.

## Docker + Cloudflare Access

One box runs the container, published on the host's loopback only. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(`cloudflared` on the same box, pointing at `http://127.0.0.1:4517`) puts HTTPS in front of it, and a Cloudflare Access
application on that hostname decides who gets through (phone included). Nudge then checks the Access token itself,
plus Host and Origin (see [Security model](SECURITY-MODEL.md)). It has no password of its own, so do not publish the
port anywhere else. This is one way to run it, not a requirement.

Fork the repository first and clone your fork: the auto-update below deploys whatever is on `origin/main`, so you
want that to be a branch you control, not the upstream project's.

```shell
git clone https://github.com/<you>/nudge.git ~/nudge && cd ~/nudge
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000 (see compose.yaml)
cp .env.example .env    # then fill in NUDGE_ACCESS_HOSTS, _TEAM_DOMAIN, _AUD, NUDGE_ALLOWED_USERS and the YouTube key
docker compose up -d --build            # the image build runs the unit tests
deploy/install-cron.sh                  # auto-update + nightly backup
```

In Cloudflare Zero Trust: create a self-hosted Access application for the hostname with a policy that allows only you,
copy its audience (AUD) tag into `NUDGE_ACCESS_AUD`, and add a bypass policy for the PWA's static files (listed under
[Security model](SECURITY-MODEL.md#how-requests-are-checked)). Give the YouTube key in `.env` or Settings.

- **Auto-update:** `deploy/update.sh` (cron, every 5 minutes) fetches `origin/main`; on a new commit it takes a
  pre-update snapshot (and skips the update, to retry next time, if none could be made while the app is up), builds (a
  failing test aborts the build and the old container keeps running), restarts, and rolls back to the previous image if
  the new one is not healthy within ~90s. A commit that fails is remembered and not retried, and so is an `origin/main`
  that is not a fast-forward of the checkout. Every failure exits non-zero with an `ERROR` line in `data/update.log`.
  After a successful update, dangling images and build cache older than a week are pruned (`nudge:prev`, the rollback
  image, is kept). `npm run test:deploy` rehearses all of this against a fake `docker`.
- **CI does not gate deploys yet.** The cron job deploys whatever is on `origin/main`, whether or not the GitHub Actions
  run for it passed (only the unit tests inside the Docker build stop a bad commit). To make CI a gate later: protect
  `main` with required status checks, have the workflow move a `deploy` branch (or tag) to the commit only when every
  job is green, and point `update.sh` at that ref instead of `origin/main`.
- **Backups:** `deploy/backup.sh` (cron, 03:15) snapshots the live database with SQLite's online backup API, verifies
  it, keeps 7 in `data/backups/` and 14 in an off-box directory (`NUDGE_BACKUP_DIR`; unset means no off-box copy, so put
  it in the cron line's environment, e.g. `NUDGE_BACKUP_DIR=/mnt/backup/nudge`). With it set, it exits non-zero if that
  copy fails. The snapshots `update.sh` takes before each deploy are named `pre-update-<time>.db` and kept apart (newest
  3, local only), so frequent deploys never push the nightly ones out. Separately, the app itself writes
  `data/backups/pre-migrate-v<N>-<time>.db` (newest 5 kept) before applying any schema migration to an existing
  database, and refuses to migrate if it cannot. Restore: stop the container, copy a snapshot over `data/nudge.db`,
  delete `nudge.db-wal`/`-shm`, start it. Snapshots contain your Google token and API key, so keep them private.
  `data/update.log` and `data/backup.log` are not rotated.
- **Google sign-in** redirects to `http://127.0.0.1:4517/...`, which only works on the machine itself. Connect once
  with `ssh -L 4517:127.0.0.1:4517 <box>` and open `http://127.0.0.1:4517/settings` (the tokens then live in the
  database), or connect on your laptop and copy the database across.
