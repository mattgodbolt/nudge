# Handover (2026-11-09)

Written by the previous Claude session (on the dev laptop) for the Claude session now running on `pugwash`.
Read the README first, then `gh issue list` (the issues are the backlog), then this.

## What Nudge is

A local, single-user, keyboard-driven triage inbox: YouTube comments, GitHub PRs/issues, and native todos, plus a
"Tell Nudge" assistant (typed or dictated; Anthropic Haiku tool-call) that adds todos, snoozes or completes the
selected item. State of play: everything requested so far is delivered, tested and deployed.

## Access

- **GitHub:** `gh` is logged in as `mattgodbolt` on pugwash; remote is `git@github.com:mattgodbolt/nudge`.
  Push straight to `main` (the owner's standing permission; the repo CLAUDE.md-style review rule is waived for
  Nudge). Never force-push. Commit trailer is only `Co-Authored-By: Claude ... <noreply@anthropic.com>`; never put
  Claude session links in commits.
- **Deploy box `phoenix`:** `ssh phoenix`, repo in `~/nudge`. Cron every 5 minutes runs `deploy/update.sh`: it pulls
  `origin/main`, runs the tests in Docker, builds, restarts, and rolls back on failure. So **every push to main
  auto-deploys within about 5 minutes**; the Settings > About card shows the deployed commit. Logs:
  `~/nudge/data/update.log`, `backup.log`. Nightly backup at 03:15 (7 local, 14 on the NAS `/nas/BackedUp/nudge`).
  Container `nudge` listens on 127.0.0.1:4517, fronted by `tailscale serve` at https://phoenix.tailbf3b70.ts.net
  (tailnet only; identity from Tailscale headers, there is no password).
- **Secrets:** there are none in the repo or in files. By the owner's rule ("config and keys go in the DB, not in
  code"), the Anthropic key, GitHub token, YouTube API key and Google OAuth tokens all live in `data/nudge.db` on
  phoenix, set through the Settings page. Do not read them out, print them, or copy them elsewhere. Locally the demo
  mode (`NUDGE_DEMO=1`) uses fakes, including a fake LLM, so you need no keys to develop or test.
- **Dev tooling on pugwash:** node is not installed (nvm has no versions). Run `nvm install 22` (needs
  `source ~/.nvm/nvm.sh`; the login shell is fish) then `npm ci`. Docker is available.

## Verifying changes

`npm run typecheck`, `npx prettier --check .`, `npx vitest run` (about 630 tests), and the Playwright projects
(`npm run demo:e2e`, `demo:e2e:assistant`, etc.; about 53 tests). Playwright uses fixed ports (4518-4522): never run
two Playwright runs at once. Do not use `pkill -f` with a pattern that can match your own shell's command line.

## Working agreements with the owner

- File a GitHub issue for anything outstanding and keep issues current (comment/close as work lands).
- Nothing hardcoded: configuration goes in the DB (Settings), like the YouTube key.
- Accepted limitation: one fine-grained GitHub token for all feeds (#1).
- Owner is relaxed about Google seeing dictation (browser Web Speech API); keep the README note to one line.
- Subagent worktrees are cut from `origin/main` when spawned: commit and push before spawning one.
- E2E locators: scope them to a card or toast; URL assertions must allow a trailing `?c=`.

## State of the backlog (see `gh issue list`)

Open and most likely next, in rough order of value:

- **#22** bulk "archive everything older than X" (sort orders themselves are done).
- **#24** assistant follow-ups: edit todos, more tools, search, history, recurring todos (declined for now).
- **#9 / #10** LLM triage (design in `docs/DESIGN-LLM-TRIAGE.md`, historical): phase 0 is an offline eval on the
  owner's own triage history. Confirm with the owner before starting.
- **#5** validate GitHub polling against real data; **#1** per-feed tokens; **#2** token-expiry warning;
  **#3/#4** CI status and review comments; **#12** notification enhancements; bugs **#13-#15**; deploy chores
  **#18-#19**; **#20** Google consent screen; **#16** custom domain.

Unverified on real hardware (not yet filed as issues; check with the owner and file if they hit them):

- the real Anthropic call beyond the owner's one anecdote ("remind me on friday to call Vita" landed in Snoozed);
- microphone dictation permissions on the owner's phone;
- the merged phone layout on the actual device: the round mic button (FAB) may cover the right-most quick action on
  the lowest visible row; a possible double border when filter chips and the open search coexist; the GitHub owner
  expand chevron shows as its own 32px chip in the phone nav strip.

## Design pointers

- Everything is an `items` row (ids `gh:owner/repo#N`, YouTube comment ids, `todo:<uuid>`); migrations are in
  `server/db/migrations.ts` (user_version 8). Settings are JSON key/value rows, so new settings need no migration.
- Assistant: `server/providers/anthropic/client.ts` (system prompt, tools `add_todo`, `snooze`, `mark_done`,
  `parseCommand` validates the reply), route `server/routes/todos.ts`, UI `web/src/components/Assistant.svelte`.
  A todo's due time is a snooze (`snoozed_until`); the existing waker emits the wake and "Todo due" push.
- Inbox ordering: `server/db/repo.ts` keyset pagination for `newest | oldest | arrived | source`; the client mirrors
  it in `compareItems` in `web/src/stores/inbox.svelte.ts`. Keep them in step.
- Fuller design background: `docs/PLAN.md`, `docs/OAUTH-PLAN.md`, `docs/DESIGN-SOURCES.md`,
  `docs/DESIGN-LLM-TRIAGE.md`.
