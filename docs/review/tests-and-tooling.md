# Review: tests, tooling and repo hygiene

Reviewed at commit `770cf26` (2026-11-16), read-only. Checked by reading the files cited, plus `npm run typecheck`,
`npx vitest run`, `npm run lint`, `npm audit`, `npm outdated`, `shellcheck deploy/*.sh`, one e2e spec on shifted ports,
and a pattern scan of the tree and of all 84 commits of history.

## Verdict

The unit layer is in good shape: 97 files, 1,240 tests, 3 seconds, deterministic (seeded demo world, injected clocks,
no network, no skipped tests), with real negative cases for Access token verification, undo, mute rules, snooze waking
and most migrations. The weak point is everything around it. There is no CI, so the only automated gate between a push
to `main` and the production box is the vitest run inside the Docker build: the 122 Playwright tests, `svelte-check`
and Prettier never gate a deploy, and the server tests are not even typechecked (16 latent type errors today). The
deploy script is careful about backups and rollback but fails silently, lets deploy-time snapshots evict the nightly
backups, and never prunes images. For open-sourcing, no secrets were found in the tree or in history, but the repo is
not ready as it stands: a committed e2e spec writes screenshots to a hard-coded personal scratch path, the README's
snooze keys and all four screenshots are out of date (they still show Labels), the LLM prompts name the owner
personally, history carries the deploy host's real tailnet name, and there is no CONTRIBUTING, SECURITY or example
config. None of it is hard to fix; most items are small.

Measured on this machine: typecheck 7.5 s, unit tests 4.3 s wall, Prettier check 8 s, one single-test e2e spec 33 s wall
(nearly all of it building the bundle and starting 13 demo servers).

Severity: **bug** (wrong today), **risk** (will bite under plausible conditions), **cleanup**, **nit**.
Effort: **S** (one file or a few lines), **M** (several files or a new piece of tooling), **L** (cross-cutting).

---

## 1. CI and what actually gates a deploy

### 1.1 No CI at all — risk, M

There is no `.github/` directory. Nothing runs on a push or a pull request. Auto-deploy takes whatever is on
`origin/main`.

What gates production today (`Dockerfile:13-16`, `Dockerfile:18-22`): `npx vitest run` and `npm run build`
(`vite build && tsc -p server`). What does not: the whole Playwright suite, `svelte-check` (the web half of
`npm run typecheck`), `prettier --check`, and any type error in a server test.

Why it matters: the owner does not read code and relies on tests. Of the 55 Svelte files (four views included) only one
has a component test (`web/src/components/InsightsPanel.test.ts` is the only one), so UI behaviour is covered by e2e
alone, and e2e runs only when somebody remembers to run it.

Fix: one GitHub Actions workflow on `push` and `pull_request`: `npm ci`, `npm run lint`, `npm run typecheck`,
`npm test`, `npx playwright install --with-deps chromium`, `npm run test:e2e`, uploading the Playwright report and
traces on failure. Then make deploy depend on it (see 3.1).

### 1.2 Server and shared tests, `e2e/` and `scripts/` are never typechecked — bug, S

`server/tsconfig.json:11-12` excludes `**/*.test.ts` and includes only `server/` and `shared/`; `web/tsconfig.json`
covers `web/src` only. So 70-odd server and shared test files, `e2e/*.ts`, `scripts/*.ts` and `playwright.config.ts` are
compiled by nothing (vitest and Playwright strip types without checking them).

Checking them with a scratch tsconfig gives 0 errors for `e2e/` and **16 errors** for the server and shared tests.
Examples:

- `server/db/events.test.ts:479,481`: `repo.recomputeGithubOwnership()` is not on the `Repo` contract
  (`server/contracts.ts:441` only has `recomputeOwnership`). It exists at runtime (`server/db/feeds.ts:509`), so the
  contract has drifted from the implementation.
- `server/routes/routes.test.ts:53`: the fake settings object lacks `snoozeDays`.
- `server/sync/github.test.ts:43`: the fake GitHub client is missing methods the real interface now has.
- `server/db/suggestions.test.ts:161,172,183`, `server/routes/notes.test.ts:143`, `server/routes/todos.test.ts:131`:
  fixtures use values or shapes the types no longer allow.

Why it matters: stale fakes mean tests exercise shapes production no longer has, and the compiler is the cheapest
way to hear about it.

Fix: add a `tsconfig.test.json` (noEmit, includes server and shared tests, `scripts/`, `e2e/`, the three config files)
and chain it into `npm run typecheck`; fix the 16 errors.

### 1.3 Lint is formatting only — risk, M

`package.json` `lint` is `prettier --check .`. There is no ESLint, so nothing catches a floating promise. In
Playwright that is the classic assertion that cannot fail (`expect(locator).toBeVisible()` without `await`). A grep
found none today, but nothing keeps it that way.

Fix: `typescript-eslint` with `no-floating-promises` and `no-misused-promises`, plus `eslint-plugin-playwright`
(`missing-playwright-await`, `no-wait-for-timeout`, `no-conditional-in-test`) for `e2e/`. Add `shellcheck deploy/*.sh`
to CI (it is clean today apart from two SC2012 notes).

### 1.4 No single "is it good?" command — cleanup, S

A newcomer, or an agent, has to know to run four things. Add `"check": "npm run lint && npm run typecheck && npm test"`
and `"check:all": "npm run check && npm run test:e2e"`, and use `check:all` in CI.

---

## 2. End-to-end tests: flakiness and race risks

122 tests in 17 spec files, 13 demo servers.

### 2.1 A spec writes screenshots to a hard-coded personal scratch path — bug, S

`e2e/github.spec.ts:421` sets `const SHOTS = '/tmp/claude-1000/-home-matthew-dev-nudge/<session id>/scratchpad'` and
`e2e/github.spec.ts:465` and `:506` call `page.screenshot({ path: ... })` unconditionally. Committed in `de169c0`.
Every other spec uses `process.env.NUDGE_SHOTS` and skips when it is unset.

Why it matters: on any other machine the test creates that directory tree under `/tmp` and writes PNGs there on every
run; it publishes a home-directory-derived path and a session id; and it will fail outright where `/tmp/claude-1000` is
not writable.

Fix: use the shared `shot()` helper (see 2.9) gated on `NUDGE_SHOTS`.

### 2.2 The handoff server (4518) is shared by five specs that run in parallel, and one mutates it — risk, S

`playwright.config.ts:31-36`: `own-channel`, `pwa`, `refresh`, `stats` and `usage` all use 4518.
`e2e/own-channel.spec.ts:10-11` removes the demo's own channel and adds it back. `e2e/stats.spec.ts:20-28` already
works around this with `if (await toggle.isVisible()) { ... }`: when the race goes the wrong way the scope-switch
assertions are silently skipped, so that part of the test cannot fail. `update.spec.ts:75` also reads from 4518.

Fix: give `own-channel.spec.ts` its own server (or move it onto `triage`), then delete the conditional in
`stats.spec.ts` and assert unconditionally.

### 2.3 Adventure spec depends on the real wall clock around 04:00 UTC — risk, S

`e2e/adventure.spec.ts:150-166`: the campfire test computes `campDay(Date.now())` in the test process (04:00 UTC
rollover) and asserts on the weekday name of "tomorrow". The XP it depends on was earned by earlier tests in the same
serial file. If the file straddles 04:00 UTC, the earlier work lands on the previous campfire day and the expected
messages are wrong. The server uses its own real clock plus an offset (`/api/demo/rpg-clock`).

The same file leans on tuning constants: `Math.ceil((400 - before.xp) / 8)` (`:140`), "13 items reach level 2"
(`:113`), 16 achievements, 4 bosses, 10 loot (`:92-97`). A balance tweak breaks the test although the behaviour is
right.

Fix: let the demo endpoint set an absolute time (not an offset from now) and start the file at a fixed instant; import
the XP table from `shared/rpg.ts` instead of repeating numbers.

### 2.4 Fixed sleeps — risk, S each

| Where                                                   | What                                                    | Better                                             |
| ------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `e2e/refresh.spec.ts:160` with `:170`                   | long-press is "hold 700 ms" against the app's threshold | `page.clock.install()` and `clock.runFor()`        |
| `e2e/refresh.spec.ts:38`, `:78`, `e2e/usage.spec.ts:47` | "nothing happened within 400-500 ms" negative checks    | fake clock, or assert on a counter the app exposes |
| `e2e/adventure.spec.ts:232`                             | 2.5 s "longer than the debounce"                        | fake clock                                         |
| `e2e/update.spec.ts:24`, `:39`                          | 1.5 s in-page `setTimeout` to show nothing reloads      | fake clock                                         |
| `e2e/snooze-activity.spec.ts:316`                       | 400 ms before checking rows do not overlap              | `expect.poll` on the layout check                  |

The negative ones cannot give a false failure, only a false pass on a slow machine; the long-press one can fail
either way under load.

### 2.5 Specs that poll for a background worker — risk, M

`e2e/notes.spec.ts:20-27`, `e2e/suggestions.spec.ts:117-118` reload the page every 2 s for up to 90 s until the fake
suggestion worker has got round to the GitHub rows; `e2e/backlog.spec.ts:34` waits up to 60 s for the worker to hit its
cap; `e2e/insights.spec.ts:14-24` waits up to 60 s for the history seed. They pass, but they are the slowest and most
load-sensitive tests, and a genuine "worker never suggests" bug shows up as a 90 s timeout with no clue.

Fix: a demo-only `POST /api/demo/suggest-drain` (run the worker to quiescence and return) alongside the existing
`/api/demo/tick`, `/advance` and `/comment`; seed demo history before the server starts listening.

### 2.6 Order-dependent serial files with no way back — risk, M

Nine files are `mode: 'serial'` and build on earlier tests' state (`assistant` needs the key saved by test 2;
`adventure` needs XP from tests 3 and 4; `snooze-activity` advances the waker's clock for everything after it;
`own-channel` test 2 needs test 1 to have finished cleanly). `playwright.config.ts` sets no `retries`, so today a
failure just skips the rest of the file. That is consistent, but it means (a) one flake hides every later test in the
file, (b) turning retries on later would make things worse, because the in-memory server keeps the half-changed state,
and (c) no test in these files can be run on its own with `-g`.

Fix (the structural one, and it removes 2.2 and 3.x port bookkeeping too): a worker-scoped Playwright fixture that
spawns a demo server on port 0 with the flags the file asks for (`test.use({ demo: { github: true, suggest: true } })`)
and tears it down afterwards. Each file, and each retry, gets a fresh world; the 13 `demo:e2e:*` scripts, the 13
`webServer` entries and the port table all go away.

### 2.7 Playwright config gaps — cleanup, S

`playwright.config.ts:29` onwards:

- no `forbidOnly: !!process.env.CI`: a stray `test.only` would pass a run while skipping 121 tests;
- no `trace: 'retain-on-failure'` or `screenshot: 'only-on-failure'`: a failure leaves nothing to look at;
- no `reporter` (HTML report for CI), no explicit `workers`, no explicit browser project (it is whatever the default is);
- `E2E_PORT_OFFSET` isolates ports and the bundle, but not `outputDir`: two runs in one checkout both clear and write
  `test-results/`. Set `outputDir: OFFSET ? \`test-results-${OFFSET}\` : 'test-results'`;
- the block comment at `:23-27` still begins "Three demo servers"; there are 13.

### 2.8 Selectors and assertions tied to layout and styling — cleanup, M

About 65 bounding-box measurements and about 40 CSS-class or tag locators (`.cell`, `.readout`, `.scope`,
`.legend .sw`, `.vt`, `.vtitle`, `.ghlabel`, `.lead`, `.why`, `td.num`, `a.title`, `.card.own`, `.slot`, `article`,
`.page`, `svg.sil`). The tap-target and no-sideways-scroll checks are deliberate and worth keeping. The fragile ones:

- `e2e/insights.spec.ts:232`: exact colours `rgb(205, 226, 251)` and `rgb(19, 48, 79)`: any palette change fails it;
- `e2e/github.spec.ts:390`: first row's `y < 260`, `:367` menu bottom `> 850`;
- `e2e/insights.spec.ts:90`: `.cell.nth(30)`;
- `e2e/github.spec.ts:32` `toHaveText('30')` and `:342` `/#13\d/`: demo seed sizes repeated as literals.

Fix: add `data-testid`s where a class is used as a hook; read the colour from the CSS custom property rather than
repeating the value; export the demo counts from `server/demo` and import them.

### 2.9 Helpers copied between specs — cleanup, S

- `tell()` in `assistant.spec.ts:9` and `notes.spec.ts:48`;
- `SHOTS` and `shot()` in `adventure`, `backlog`, `insights`, `notes` (four variants, with and without a settle delay),
  plus the hard-coded one in `github`;
- `H = { 'x-nudge': '1' }` in four files;
- `rows = (page) => page.getByTestId('inbox-row')` in four files;
- inbox-count readers `num` (`snooze.spec.ts:6`) and `countOf` (`reply-api.spec.ts:7`), and the same expression inline
  seven times in `inbox.spec.ts`;
- `openGithub` and `withTurn` in `notes` and `suggestions`;
- "goto /inbox, wait for a row" as a `beforeEach` in seven files.

Fix: `e2e/helpers.ts` (or fixtures: `inboxPage`, `api` with the header set, `shot`).

### 2.10 Stale comments in specs — nit, S

`e2e/snooze.spec.ts:3` and `:14-17` say the file shares a server with other specs running in parallel and must avoid
the first rows; it has had a private server (4520) for a while. `e2e/snooze-activity.spec.ts:110` and
`e2e/notes.spec.ts:283` say "later today" for a preset that is now "In 1 hour".

### 2.11 Everything starts for every run — cleanup (DX), M

`npx playwright test stats.spec.ts` builds the bundle and starts all 13 servers, including the 300-item backlog server
that then runs 23 suggestion passes: 33 s for one test. The fixture in 2.6 fixes this as a side effect.

---

## 3. Deploy script, Dockerfile, dependencies

### 3.1 Auto-deploy trusts `origin/main` unconditionally — risk, M

`deploy/update.sh:10-17` fetches and fast-forwards to whatever is on `main` every five minutes, then builds and runs it
on a host where the cron user controls Docker and the database holds a Google refresh token and API keys. That was a
reasonable trade for a private repo with one committer. Once public, a merged pull request is running on that box
within five minutes with no review of code by the owner, by design, and no CI.

Fix: protect `main` (required status checks, no direct pushes from anyone else); have CI fast-forward a `deploy`
branch (or move a tag) only when every check including e2e is green, and point `update.sh` at that ref. This also
makes e2e a deploy gate without lengthening the Docker build.

### 3.2 Deploy failures are silent — risk, S

`deploy/update.sh:42-45` and `:55-56`: a failed build or an unhealthy start writes a line to `data/update.log` and
records the commit in `data/.failed-sha`. Nothing tells the owner, who uses the product rather than reading logs: the
visible symptom is "my fix never showed up". The mark is also permanent until the next push (`:14`), so a transient
failure (registry down during `npm ci`, the 25-minute timeout) is never retried.

Fix: on failure, notify (the app already has Web Push and a `/api/push` module; or surface "last deploy failed at
<sha>" in Settings > About by reading a status file from `data/`). Retry a failed sha a bounded number of times before
giving up.

### 3.3 Pre-update snapshots evict the nightly backups — risk, S

`deploy/update.sh:24` calls `deploy/backup.sh`, which names every snapshot `nudge-<time>.db` and keeps the newest 7
locally and 14 on the NAS by count (`deploy/backup.sh:7-8,17-18,25`). With pushes several times a day (84 commits in
ten days) all seven local copies, and soon all fourteen off-box ones, are from the last day or two. A problem noticed
after a week has no backup old enough.

Fix: give pre-update snapshots their own name and retention (`pre-update-*.db`, keep 3), or make nightly retention
date-based (one per day for N days).

### 3.4 The health window is tight for a migrating start — risk, S

`Dockerfile:42-43` has `--interval=30s` and no `--start-interval`, so the first probe is 30 s after start and the next
at 60 s; `deploy/update.sh:49-53` waits 90 s. A start that snapshots (`VACUUM INTO`) and migrates a large database on
slow storage (the vitest config itself notes "many seconds on slow storage (e.g. Docker on ZFS)") has two or three
chances. A false "unhealthy" is expensive here: the rollback then meets a migrated schema, refuses to start, and
`update.sh:68-73` restores the pre-update snapshot, discarding whatever changed since.

Fix: `--start-period=120s --start-interval=2s` on the HEALTHCHECK; have `update.sh` poll `curl
127.0.0.1:4517/api/bootstrap` itself with a longer deadline; before restoring a snapshot, check the logs for
`SchemaTooNewError` rather than inferring it.

### 3.5 Images and build cache are never pruned — risk, S

Nothing in `deploy/` runs `docker image prune` or `docker builder prune`. Every deploy leaves the previous `latest`
dangling (only one `prev` tag is kept) plus build cache with a toolchain layer. On a small box the disk fills
eventually, and the failure mode is a build that fails and is then marked as a bad commit (3.2).

Fix: `docker image prune -f` and `docker builder prune -f --filter until=168h` after a successful deploy.

### 3.6 Backup defaults are the owner's — cleanup, S

`deploy/backup.sh:6`: `NAS_DIR` defaults to `/nas/BackedUp/nudge`. For anyone else the nightly job exits 1 every night
(`:28-30`) and `update.sh` logs a WARN on every deploy. The README mentions it (`README.md:308-309`), but the default
should be "no off-box copy unless `NUDGE_BACKUP_DIR` is set", with a clear log line.

Also `compose.yaml:12` hard-codes `user: '1000:1000'` (use `${NUDGE_UID:-1000}:${NUDGE_GID:-1000}`), and
`compose.yaml:17` has `phoenix.your-tailnet.ts.net` as the example (the owner's host name).

### 3.7 Every commit redeploys, including docs — nit, S

`update.sh` compares shas only, so a README change takes a backup, rebuilds, restarts the container and drops the live
event stream. Skip when `git diff --name-only $local_sha $remote` touches only `docs/`, `*.md`, `e2e/`.

### 3.8 Dockerfile — mostly good

Good: multi-stage, tests gate the image, non-root (`USER node`), HEALTHCHECK, no secrets or build args beyond the
sha, toolchain kept out of the runtime image, `npm ci` from the lockfile, `SIGTERM` handled (`server/index.ts:321-322`).

- cleanup, S: `FROM node:22-bookworm-slim` (`Dockerfile:4,29`) floats; pin a minor or a digest and let Dependabot
  move it.
- cleanup, S: `dompurify`, `marked` and the two `@fontsource-variable/*` packages are in `dependencies`
  (`package.json:47-56`), but are only imported by the web bundle (`web/src/lib/sanitize.ts:1-2`, `web/src/main.ts:1-2`), so
  `npm ci --omit=dev` installs them into the runtime image for nothing. Move to `devDependencies`.
- nit, S: `.dockerignore` lacks `docs`, `e2e`, `*.md`, `.claude`, `scripts`, so a docs change busts the `COPY . .`
  cache for both the test and build stages; it still lists `youtubey`.
- nit, S: the healthcheck hard-codes 4517 and calls `/api/bootstrap` (the full bootstrap payload every 30 s). A tiny
  `/api/health` would be cheaper and say what it means.
- nit, S: `compose.yaml` passes only the variables it lists, so `NUDGE_PUSH_SUBJECT`, `NUDGE_GOOGLE_CLIENT_ID/SECRET`
  from the README's table are silently ignored in the Docker deployment. Add them or use `env_file`.

### 3.9 `update.sh` details — nit, S

- A non-fast-forward `main` (`:17`) makes the script fail every five minutes forever with only a git error in the log.
  Log it clearly and stop retrying that sha.
- The script survives being updated by its own `git merge` only because git replaces files rather than rewriting them
  in place. Wrapping the body in `main() { ... }; main "$@"` makes that explicit and costs nothing.
- `data/update.log` and `data/backup.log` are never rotated (slow growth; note it).
- There are no tests for `deploy/` at all. The rollback path (the part that restores a database) has presumably never
  run. A dry-run mode, or one scripted rehearsal against a throwaway compose project, would be worth having before
  relying on it.

### 3.10 Dependencies — fine

Lockfile committed; `npm ci` everywhere. `npm audit`: 2 low (deepmerge via `@sveltejs/vite-plugin-svelte`, dev only,
no fix available). `npm outdated`: patch and minor bumps only, plus majors for `typescript` (7) and `web-push` (4).
Caret ranges are fine with a lockfile.

- cleanup, S: `@types/dompurify` is unused (dompurify 3 ships its own types).
- cleanup, S: no Dependabot or Renovate config; add one with the CI workflow (npm, Docker base image, Actions).
- nit: `package.json` has `engines.node >= 22` but no `.nvmrc` / `.node-version`.

---

## 4. Unit tests: quality and gaps

### 4.1 What is good (keep doing it)

- Clocks are injected; only six files use fake timers and none read the wall clock for an assertion that could flip.
  `Math.random` appears in no test. No test touches the network (the SSE tests in `server/routes/routes.test.ts:429-488`
  use a loopback listener on port 0). No `.skip`, `.only` or `.todo`. No snapshot tests.
- `server/auth/access.test.ts`: wrong key, tampered payload, `alg: none` and HS256, expired, not-yet-valid, missing
  `exp`, wrong-typed claims, oversized input, key rotation, refetch rate limit, fail-closed on fetch errors.
- `server/security.test.ts`: forged Tailscale header on an Access host, loopback Host through a tunnel, bypass paths
  limited to GET/HEAD.
- Undo: twice, expired, unknown, "does not clobber a later change" (`server/db/repo.test.ts:356-390`,
  `server/db/snooze.test.ts:89-112`).
- Mutes and GitHub dedupe: idempotent polling, never reopening a muted item, owner rules, same rule twice
  (`server/db/feeds.test.ts:89-240`).
- `server/db/snapshot.test.ts`: refuses to migrate when the snapshot cannot be made.

### 4.2 Migration coverage has holes at the newest end — risk, M

`server/db/migrations.test.ts` upgrades from v2, v4, v6, v9, v10, v11, v12 and v14 with a few rows each. Missing:

- **014 (done_reason) and 016 (snooze until activity)**: no test starts from v13 or v15 with rows in place. 016 is the
  newest migration and the one most recently run against the real database.
- **A populated end-to-end upgrade.** No test builds an old database with rows in every table (videos, threads,
  comments with every state, labels, drafts, feeds, items, mute rules, events, suggestions, notes, push subscriptions,
  usage) and runs the whole chain. `server/hardening.test.ts:26-34` does v1 to latest with a single video row.
- **Integrity after upgrade.** `foreign_key_check` / `integrity_check` are asserted for some migrations in
  `migrations.test.ts` but not as a rule for every upgrade path. The table rebuilds (007, 013) are where orphaned rows
  would appear.
- **Failure atomicity.** `server/db/db.ts:28-33` runs all pending migrations in one transaction; no test shows that a
  failing later migration leaves `user_version` and the data as they were.

Fix: one shared builder, `seedAtVersion(db, n)`, that inserts a realistic spread for the schema as it stood at `n`
(the `v6()` helper at `migrations.test.ts:81-106` is the model), and a table-driven test: for every `n` from 1 to
latest minus 1, seed, migrate, then assert row counts survive, `PRAGMA foreign_key_check` is empty,
`PRAGMA integrity_check` is `ok`, and the app's own repository can list the inbox. Add a rule to the contributing
notes: a new migration comes with a `seedAtVersion` step. Optionally, keep a scrubbed real-shaped fixture database
(schema plus synthetic rows produced by the demo world at an old commit) under `server/db/fixtures/`.

### 4.3 Fixture setup is repeated per file — cleanup, M

Ten test files define their own `setup()`, others `make`, `build`, `mk`, `seed`, `seedComment`; the old-schema
bootstrap (`db.exec(MIGRATIONS.slice(0, n).join('\n')); db.pragma('user_version = n')`) is written out 14 times across
`migrations.test.ts`, `events.test.ts`, `snapshot.test.ts` and `insights.test.ts`. Two shared helper files exist
(`server/sync/test-helpers.ts`, `server/reply/test-helpers.ts`) and 27 files use them, so the pattern is there; it has
not reached `server/db` and `server/routes`.

Fix: `server/test/builders.ts` with `memoryRepo()`, `dbAtVersion(n)`, `aComment()`, `aGithubItem()`, `aSettings()`
(which would also have caught `snoozeDays` in 1.2), and `appWith(deps)` for route tests.

### 4.4 Real sleeps in unit tests — risk, S

`server/routes/snooze-activity.test.ts:37` and `server/routes/todos.test.ts:19` define `settle()` as a 10-20 ms
`setTimeout` to let fire-and-forget work finish; `server/routes/snooze-context.test.ts:132,138,152` and
`server/push/notifier.test.ts:189` (80 ms) do the same inline. On a loaded machine (the Docker build runs with
`--maxWorkers=2` for exactly that reason) 20 ms is not a guarantee, and the project rule is to investigate every flake.

Fix: have the code under test expose the promise (or an `idle()` hook) and await it; or `vi.waitFor`.

### 4.5 Time-zone-sensitive spots — nit, S

`web/src/lib/snooze.test.ts:77` asserts local `getHours()` and
`web/src/components/InsightsPanel.test.ts:77` compares with the runner's zone. Both pass anywhere today, but nothing
pins the zone. Set `TZ` once in `vitest.config.ts` (`test.env.TZ = 'America/Chicago'`, or run the suite under two zones
in CI) so preset and DST logic is tested on purpose.

### 4.6 Coverage is not measured — cleanup, S

No `@vitest/coverage-v8`. Not a target to chase, but a one-off report would show which of `server/routes/api.ts`,
`server/db/repo.ts` and the stores are thin, which is useful when the tests are the only reviewer.

### 4.7 Vitest notices — nit, S

Every run prints "no Svelte config found" twice and "at least ~684ms faster with isolate: false". Add a minimal
`svelte.config.js`; leave isolation on.

---

## 5. Open-source readiness

### 5.1 Secrets and personal data: scan results

Scanned the tree and `git log --all -p` for Google API keys, Anthropic keys, GitHub tokens (classic and fine-grained),
Google OAuth client secrets and ids, access and refresh tokens, private key blocks, Tailscale keys, Slack tokens,
`.env` and database files, session links and session trailers.

- **No secret found**, in the tree or in history. No `.env`, `.db` or key file was ever committed. No session links
  or session trailers in any commit message or file. All commits are by one author; trailers are
  `Co-Authored-By` only.
- **risk, M (decide before publishing):** history contains the deploy host's real tailnet DNS name
  (`phoenix.tail…​.ts.net`, 4 added lines across `2d44118`, `0bb4b27`, `88099e8`) and the since-deleted
  `docs/HANDOVER.md` (added `0bb4b27`, removed `555c16c`), which names the dev and deploy machines, the checkout path
  on the box, the NAS path and the working arrangement. None of it is a credential and the name resolves only inside
  the tailnet, but it is infrastructure detail that publishing the history makes permanent. Options: accept it; or
  publish from a fresh history (one squashed "initial public commit"), which is the only time this is cheap. The
  global rule against force-pushing does not bite if the public repo is a new remote, but this is the owner's call.
- **cleanup, S:** in the tree today: `/home/matthew/dev/youtubey/...` in `docs/PLAN.md:5,834-839` and
  `docs/OAUTH-PLAN.md:447-451`; the scratch path in `e2e/github.spec.ts:421` (2.1); host name `phoenix` in
  `docs/DESIGN-LLM-TRIAGE.md` (8 places), `docs/DESIGN-SOURCES.md:443` and `compose.yaml:17`; `/nas/BackedUp/nudge`
  in `deploy/backup.sh:6`.
- **nit:** the owner's real channel id is a test input (`shared/youtube-urls.test.ts:15-16`) and in
  `docs/PLAN.md:803`; the owner's GitHub login is test data in `server/routes/github.test.ts:80,183-197` and a
  placeholder in `web/src/views/SettingsView.svelte:624`. Public information; swap for neutral values if wanted.
- `docs/DESIGN-LLM-TRIAGE.md:34-50` reports aggregate counts from the owner's real database. No third-party comment
  text or names were seen quoted, but read that section once with publication in mind.

### 5.2 The LLM prompts name the owner — bug (for anyone else), M

`server/classify/anthropic.ts:11` (the production system prompt, used at `:194`): "You triage the inbox of Matt
Godbolt, creator of Compiler Explorer, who also runs a YouTube channel about C…", with "Matt" throughout the rules
(`:14-15`, `:111`) and `is_matt` / `from="matt"` in the message markup (`:68,76,89`). `server/classify/snooze.ts:18`
(Draft a nudge) likewise. The data model follows: `turn?: 'matt' | 'them' | 'nobody'` in `shared/types.ts:150`,
stored in the `suggestions` table (`server/db/repo.ts:1110`), rendered as `data-turn="matt"`
(`web/src/components/SuggestionChip.svelte`), `isMatt` in `server/contracts.ts:697`, and "Would Matt need to act on
this?" in the labelling pages (`server/classify/labelPage.ts:55-60`).

Why it matters: anyone else who adds an Anthropic key gets suggestions written for a different person, and drafted
nudges that speak as him.

Fix: an "About me" setting (name, one line of context) interpolated into both prompts, defaulting to neutral wording
("the owner"); rename the markup to `is_owner`. Renaming the stored `turn` value needs a small migration (or map at the
boundary and leave the column alone). Bump the prompt version, since it is part of the suggestion state key.

### 5.3 README is wrong about the snooze keys — bug, S

`README.md:185` says "`1`-`4` presets, `5` a time, `6` until activity" and `README.md:203` says "Until activity (`6`)".
Since `bc56f5c` there are five preset slots (`web/src/lib/snooze.ts:34-43`), the keys run `1`-`7`
(`web/src/components/SnoozeMenu.svelte:147`), and the e2e test presses `7` for Until activity
(`e2e/snooze-activity.spec.ts:72`). Following the README, `6` opens the date picker.

Longer term: generate the key table from the keymap registry (the app's `?` overlay already does) and have a unit
test fail when the README table and the registry disagree.

### 5.4 All four screenshots predate several features — bug, S

`docs/screenshots/*.png` were captured on 2026-11-11 (`88099e8`). `inbox.png` and `github-thread.png` show a
**Labels** section in the sidebar, a label chip on rows and a **Label** button in the toolbar; user-defined labels were
removed in `1b1206f` (migration 015). They also lack the suggestion chips, the No action button, the Adventure chip
and the current toolbar layout. The README says "All screenshots … are the built-in demo mode", which is true, of an
older build.

Fix: retake from `npm run demo`. Better, a small `npm run shots` script that uses the existing `NUDGE_SHOTS`
plumbing against a demo server to regenerate exactly these four files, so they can be refreshed with one command.

### 5.5 README and docs: other inaccuracies and gaps — cleanup, S each

- The configuration table (`README.md:68-79`) omits variables the code reads: `NUDGE_DEMO_SUGGEST`,
  `NUDGE_DEMO_HISTORY`, `NUDGE_DEMO_COMMENTS`, `NUDGE_DEMO_BACKLOG` (`server/index.ts:123-176`, `:276`), `NUDGE_WEB_DIR`,
  `GIT_SHA`, `NUDGE_BACKUP_DIR`, and for development `E2E_PORT_OFFSET` and `NUDGE_SHOTS`. `npm run demo` itself sets
  two of the undocumented ones.
- `README.md:258`: `npm run test:e2e` with no mention of `npx playwright install chromium`, which a fresh clone needs.
- `README.md:263` links `docs/PLAN.md` as "Design notes". It is the original build plan: it opens with the Python CLI
  at `/home/matthew/dev/youtubey`, refers to `server/db/migrations/001_init.sql` and `server/youtube/fake.ts` (neither
  exists), and describes labels. `docs/OAUTH-PLAN.md` has the same absolute paths. The two `DESIGN-*` documents
  carry a "Status: historical proposal" line; these two do not. Either move all four to `docs/history/` with a
  one-line status header and strip the absolute paths, or drop PLAN.md and write a short current `docs/ARCHITECTURE.md`
  from the README's Development paragraph.
- The README is 438 lines with the Google Cloud walkthrough, the snooze design and the telemetry description inline.
  Consider moving those to `docs/` and keeping the README to what it is, a quick start, keys, security model and links.
- `README.md:349` and the Settings page link to issue numbers in the repo; make sure the issues are public-facing
  before the repo is.

### 5.6 Missing community files — cleanup, S

Present: `LICENSE` (MIT, 2026), `"license": "MIT"` in `package.json`. Absent:

- `SECURITY.md`. This matters more than usual: the app has no login, posts to YouTube as the owner and stores tokens.
  Say how to report a problem privately and restate that the port must never be exposed.
- `CONTRIBUTING.md`: how to run the demo, `npm run check`, the e2e port offset, "a new migration needs an upgrade
  test", and whether outside pull requests are wanted at all for a personal tool (given 3.1, saying "issues welcome,
  PRs by arrangement" is a legitimate answer).
- `.env.example` matching `compose.yaml`.
- `.github/`: CI workflow, Dependabot, an issue template.
- No changelog or tags, though `package.json` says `0.2.0`. Tag the first public commit.

License headers per file are not needed for MIT and none exist; leave it.

### 5.7 `.gitignore` gaps — nit, S

Add `.env.*` with `!.env.example` (only `.env` is ignored today, so `.env.local` could be committed), `coverage/`,
`blob-report/`, `test-results-*/`, `.claude/`, `*.log`. Remove `__pycache__` (no Python since the rewrite). `.idea/`
is ignored now but its files are in history (harmless).

### 5.8 Leftovers from the rename — nit, S

`.dockerignore` lists `youtubey`; `server/hardening.test.ts:21` uses a `yt-perm-` temp prefix. The `YOUTUBEY_*`
fallbacks are documented and tested (`server/config.rename.test.ts`); decide whether a public first release needs to
carry them at all.

---

## 6. Developer experience

- **Running the demo** is good: `npm install && npm run demo`, no keys, and the server refuses to point demo mode at
  a real database. `README.md:46-51` is accurate about ports.
- **Script sprawl** — cleanup, S/M: 13 `demo:e2e:*` scripts (`package.json:25-37`) differ by a port and a few flags,
  and the same ports appear again in `playwright.config.ts` (twice each) and `e2e/update.spec.ts:75`. Short of the
  fixture in 2.6, generate the `webServer` list from one table in `playwright.config.ts` using each entry's `env`, and
  delete the scripts.
- **No `check` script** (1.4) and no pre-commit hook. A hook running `prettier --check` on staged files and the
  typecheck would suit a repo where commits are pushed straight to `main`.
- **Speed** is fine for the fast loop (lint + typecheck + unit under 20 s). The full e2e time was not measured (another
  run may have been using the machine); a single spec costs about 30 s of fixed overhead (2.11).
- **Editor config**: `.prettierrc` exists; add `.editorconfig` and `.nvmrc` for contributors without the plugin.
- **`npm start`** rebuilds every time (`package.json:23`); fine for a personal tool, worth a word in the README.

---

## Before going public

- [ ] Remove the hard-coded scratch path and unconditional screenshots from `e2e/github.spec.ts:421,465,506` (2.1)
- [ ] Decide on history: publish as is (accepting the tailnet host name and the deleted handover notes), or start the
      public repo from a fresh squashed commit (5.1)
- [ ] Make the LLM prompts owner-neutral, or configurable, and bump the prompt version (5.2)
- [ ] Fix the snooze keys in `README.md:185,203` (5.3)
- [ ] Retake the four screenshots without Labels (5.4)
- [ ] Strip `/home/matthew/...` paths and `phoenix` from `docs/`, `compose.yaml:17`; mark PLAN.md and OAUTH-PLAN.md as
      historical or move them (5.1, 5.5)
- [ ] Make `NUDGE_BACKUP_DIR` opt-in instead of defaulting to `/nas/BackedUp/nudge` (3.6)
- [ ] Add `SECURITY.md`, `CONTRIBUTING.md`, `.env.example` (5.6)
- [ ] Add CI: lint, typecheck (including tests and e2e), unit, e2e (1.1, 1.2)
- [ ] Protect `main`, and point the cron deploy at a ref that only moves when CI is green (3.1)
- [ ] Complete the README configuration table; mention `npx playwright install chromium` (5.5)
- [ ] `.gitignore`: `.env.*`, `coverage/`, `.claude/` (5.7)
- [ ] Check that issues referenced from the README and the app read sensibly to strangers (5.5)
- [ ] Read `docs/DESIGN-LLM-TRIAGE.md:34-50` once for anything about real commenters (5.1)
- [ ] Tag the first public commit

## Top 10 to do first

1. **Remove the scratch-path screenshots from `e2e/github.spec.ts`** (2.1). bug, S. Wrong on every machine but one.
2. **Add CI running lint, full typecheck, unit and e2e** (1.1). risk, M. Everything else rests on it.
3. **Gate the cron deploy on CI and protect `main`** (3.1). risk, M. Required before accepting any outside change.
4. **Typecheck the tests, `e2e/` and `scripts/`; fix the 16 errors** (1.2). bug, S.
5. **Fix the README snooze keys and retake the screenshots** (5.3, 5.4). bug, S.
6. **Make the LLM prompts owner-neutral or configurable** (5.2). bug for other users, M.
7. **Tell the owner when a deploy fails; retry transient failures** (3.2). risk, S.
8. **Separate pre-update snapshots from nightly backups; prune Docker images** (3.3, 3.5). risk, S.
9. **Table-driven migration test from every old version with populated tables and integrity checks** (4.2). risk, M.
10. **Per-file demo server fixture for e2e** (2.6), which also removes the shared-server race (2.2), the port table and
    the 30 s start-up tax (2.11). risk, M. Until then, at least move `own-channel.spec.ts` off the shared server and
    drop the conditional in `stats.spec.ts`.
