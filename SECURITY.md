# Security

Nudge is a personal tool with no login of its own. It stores API keys, a GitHub token and a Google refresh token that
can post to YouTube as you, so a hole in it matters.

## Reporting a problem

Please report anything you think is a vulnerability privately, through GitHub's
[private vulnerability reporting](https://github.com/mattgodbolt/nudge/security/advisories/new) for this repository,
not in a public issue. Say what you found, how to reproduce it, and what it lets someone do. You will get a reply,
and a fix or an explanation, as soon as it can be looked at; this is a one-person project with no bug bounty.

## What is in scope

- Ways past the request checks in `server/security.ts`: Host and Origin checks, the `X-Nudge` header, and the
  Cloudflare Access token verification in `server/auth/access.ts`.
- Anything that sends a stored secret back to the browser, or writes it to a log.
- Anything that makes Nudge write to GitHub, or post to YouTube without you asking.
- The deploy scripts in `deploy/` doing something unsafe with the database or its backups.

## Running it safely

- Keep the port on loopback. The server listens on `127.0.0.1` by default; in Docker publish it to `127.0.0.1` only, as
  `compose.yaml` does. Anything that can reach the port directly with a loopback `Host` header is treated as local.
  A loopback `Host` is trusted on the Host header alone, so any other process on the same machine, or any container on
  the same compose network, can reach the app and act as you.
- To reach it from elsewhere, put it behind Cloudflare Access and set `NUDGE_ACCESS_HOSTS`, `NUDGE_ACCESS_TEAM_DOMAIN`,
  `NUDGE_ACCESS_AUD` and `NUDGE_ALLOWED_USERS` (see [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) and [docs/DEPLOYING.md](docs/DEPLOYING.md)). Nudge refuses to start with an
  incomplete Access setup.
- The database (`data/nudge.db`) and every backup of it hold your tokens and keys. Keep them private.
- Give the Anthropic key a small spend limit, and the GitHub token read-only access (see [docs/ASSISTANT.md](docs/ASSISTANT.md) and [docs/GITHUB.md](docs/GITHUB.md)).
- The author's own deployment updates itself from `main` (`deploy/update.sh`), so merged changes are deployed there
  automatically; if you deploy Nudge yourself you can choose not to use that auto-update and pull changes by hand.
