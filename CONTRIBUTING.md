# Contributing

Nudge is a personal tool, developed in the open. Issues (bugs, ideas) are welcome. Pull requests are welcome too, but
for anything bigger than a small fix please open an issue first: the author's own deployment updates itself from
`main`, so every change is reviewed with that in mind.

## Getting started

Needs Node 22 or later.

```shell
npm install
npm run demo     # a fake world, no keys or network: http://127.0.0.1:5173
```

`npm run demo` keeps its data in `data/demo.db` and refuses to start against a database that holds real sources. See
the README's "Configuration" table for the `NUDGE_DEMO_*` switches (a fake GitHub organisation, fake suggestions,
weeks of history for Insights, and so on).

## Before you push

```shell
npm run check    # typecheck (server, tests, e2e, scripts, web) + Prettier + unit tests
npm run test:e2e # the Playwright suite
```

`npm run format` fixes formatting. `npm run shots` retakes the README screenshots from demo mode (`scripts/screenshots.ts`). CI (`.github/workflows/ci.yml`) runs the same on every push and pull request, plus
`npm run test:deploy`, a sandboxed rehearsal of the deploy scripts.

## End-to-end tests

- A fresh clone needs the browser once: `npx playwright install chromium`.
- `npm run test:e2e` builds the web bundle once, then starts 15 in-memory demo servers on ports 4518-4532, each with
  the flags its specs need (see `playwright.config.ts` and the `demo:e2e:*` scripts in `package.json`).
- **Port offset:** to run two suites at once (two checkouts, or another run already using those ports), give each a
  different `E2E_PORT_OFFSET`, a multiple of 100: `E2E_PORT_OFFSET=1700 npm run test:e2e`. Every port moves by the
  offset, and the bundle and `test-results` go to directories of their own, so neither run disturbs the other.
- Some specs can save screenshots for eyeballing a layout: set `NUDGE_SHOTS` to a directory. Without it they write
  nothing.
- A flaky test is a bug: find the race rather than rerunning until it passes.

## Conventions

- Tests come with the change: unit tests next to the code (`*.test.ts`), an e2e spec for anything a user does.
- A new database migration needs a test that upgrades from the previous schema with rows in place
  (`server/db/migrations.test.ts`).
- Comments say why, not what. Prettier decides formatting (120 columns).
- By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
