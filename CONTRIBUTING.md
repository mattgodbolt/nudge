# Contributing

Nudge is a personal tool, developed in the open. You are welcome to use it and to fork it (MIT). The author has no
spare time to support it or to review outside changes, so this is not a project that is looking for contributors:
issues and pull requests are welcome to be sent but may go unanswered or be declined. If you do want to send
something, keep it small, or open an issue first rather than writing a large patch. The author's own deployment
updates itself from `main`, so every change is reviewed with that in mind.

## Getting started

Needs Node 22 or later.

```shell
npm install
npm run demo     # a fake world, no keys or network: http://127.0.0.1:5173
```

`npm run demo` keeps its data in `data/demo.db` and refuses to start against a database that holds real sources. See
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#environment-variables) for the `NUDGE_DEMO_*` switches (a fake GitHub
organisation, fake suggestions, weeks of history for Insights, and so on), and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the code's layout, every command and the offline tooling.

## Before you push

```shell
npm run check    # typecheck (server, tests, e2e, scripts, web) + Prettier + docs links + unit tests
npm run test:e2e # the Playwright suite
```

`npm run format` fixes formatting. `npm run shots` retakes the screenshots in `docs/screenshots/` from demo mode (`scripts/screenshots.ts`). CI (`.github/workflows/ci.yml`) runs the same on every push and pull request, plus
`npm run test:deploy`, a sandboxed rehearsal of the deploy scripts. The end-to-end suite has a few things worth
knowing (a browser to install once, `E2E_PORT_OFFSET` for running two suites at once, `NUDGE_SHOTS`): see
[End-to-end tests](docs/DEVELOPMENT.md#end-to-end-tests).

## Conventions

- Tests come with the change: unit tests next to the code (`*.test.ts`), an e2e spec for anything a user does.
- A new database migration needs a test that upgrades from the previous schema with rows in place
  (`server/db/migrations.test.ts`).
- Comments say why, not what. Prettier decides formatting (120 columns).
- By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
