# Development

How the code is laid out, how to install it, the commands and test suites (unit, end-to-end and the deploy rehearsal),
and the offline tools for studying how you triage. How to send a change, and the conventions it should follow, are in
[CONTRIBUTING.md](../CONTRIBUTING.md). Back to the [README](../README.md).

## The code

Svelte 5 + Vite in `web/`, a Fastify server in `server/`, SQLite via `better-sqlite3`, and types shared between
them in `shared/` (`shared/api.ts` is the HTTP contract). The server is built from small injected pieces
(`server/sync` for the engines and schedulers, `server/db` for the repository and migrations, `server/providers`
for GitHub and Anthropic, `server/youtube`, `server/reply` for posting, `server/push`, `server/demo` for the fake
world), and the web app talks to it over `/api` plus a server-sent event stream.

## Installing

Needs Node 22 or later. `npm install` may list packages whose install scripts have not been reviewed. Two of them must
be allowed to run: `better-sqlite3` (fetches, or else compiles, its native SQLite module) and `esbuild` (installs its
binary for Vite and `tsx`); `npm approve-scripts better-sqlite3 esbuild` records that in `package.json`. Where no
prebuilt `better-sqlite3` binary matches your platform it compiles from source, which needs Python 3, `make` and a C++
compiler (on Debian or Ubuntu, `apt install python3 make g++`).

## Commands

| Command                           | What it does                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                   | Everything quick: `typecheck`, `lint`, the docs link check and `test`. Run it before every push                             |
| `npm test`                        | Unit and component tests (vitest)                                                                                           |
| `npm run test:e2e`                | Playwright against 15 in-memory demo servers (ports 4518-4532). A fresh clone first needs `npx playwright install chromium` |
| `npm run test:deploy`             | Rehearses `deploy/update.sh` and `deploy/backup.sh` in a sandbox with a fake `docker`                                       |
| `npm run typecheck`               | `tsc` for the server, its tests, `e2e/` and `scripts/`, plus `svelte-check` for the web app                                 |
| `npm run lint` / `npm run format` | Prettier check / write                                                                                                      |
| `npm run check:links`             | Checks that every relative link and `#anchor` in the README, CONTRIBUTING.md, SECURITY.md and `docs/` resolves              |
| `npm run build`                   | Production build into `dist/`                                                                                               |

GitHub Actions ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs `npm run check`, the deploy rehearsal
and the Playwright suite on every push and pull request.

## End-to-end tests

- A fresh clone needs the browser once: `npx playwright install chromium`.
- `npm run test:e2e` builds the web bundle once, then starts 15 in-memory demo servers on ports 4518-4532, each with
  the flags its specs need (see `playwright.config.ts`, which has one table of servers). They all run
  in demo mode, the only mode in which `NUDGE_DB=:memory:` is allowed.
- **Port offset:** to run two suites at once (two checkouts, or another run already using those ports), give each a
  different `E2E_PORT_OFFSET`, a multiple of 100: `E2E_PORT_OFFSET=1700 npm run test:e2e`. Every port moves by the
  offset, and the bundle and `test-results` go to directories of their own, so neither run disturbs the other.
- Some specs can save screenshots for eyeballing a layout: set `NUDGE_SHOTS` to a directory. Without it they write
  nothing.
- A flaky test is a bug: find the race rather than rerunning until it passes.

## Learning how you triage (offline tooling)

Nudge records habit data (see [Habit context](PRIVATE-DATA.md#habit-context-private-local)) and has offline tools for
studying it. None of this runs in the app; it all works on a copy of a database.

- `npm run export:events -- <db> [--since <iso>]` dumps the `item_events` history as JSONL.
- `npm run report:habits -- <db>` prints a read-only summary of how you triage.
- `scripts/triage-eval/export.mjs <db>` exports a secrets-free slice of items (public text only) as JSONL.
- `npm run eval:classify` (`server/classify`) evaluates an LLM triage classifier against your own decisions:
  `sample` builds a set to label by hand, `run` classifies it (needs `ANTHROPIC_API_KEY`, else the Anthropic key
  stored in the `--db` copy's Settings, and asks to confirm the projected cost), `score` compares with your labels;
  `run` and `score` build the prompt from your profile, read from `--db <copy of nudge.db>` or given as
  `--owner-name` and `--owner-about`, and stop with a message when there is none; `rank-sample` and `rank-score` do
  the same for a priority ranking built from pairwise comparisons (Bradley-Terry). Output goes under `data/eval/`.
