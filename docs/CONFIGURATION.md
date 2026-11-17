# Configuration

Nudge runs with no configuration at all. What it can be told comes from two places: environment variables, read at
startup, and the Settings screen, stored in the database. Where both can hold the same thing (the YouTube key and the
Google OAuth client), the environment variable wins. There are no key files. Back to the [README](../README.md).

## Which wins

- **YouTube Data API key:** `YOUTUBE_API_KEY`, else the key pasted into **Settings > Connections > YouTube API key**.
  Settings can only replace a key stored there; one from the environment is shown as such ("change it there").
- **Google OAuth client** (for posting replies): `NUDGE_GOOGLE_CLIENT_ID` and `NUDGE_GOOGLE_CLIENT_SECRET` (both must be set;
  a half-set pair is ignored), else the client pasted into **Settings > Connections > Post replies from Nudge**.
- **Anthropic key and GitHub token:** Settings only.

Anything entered in Settings lives in the database, so it is in every backup of it too (see
[Deploying](DEPLOYING.md#docker--cloudflare-access)). Stored secrets are never sent back to the browser.

## What is in Settings

- **You:** About you (the profile every model prompt is built from), My channels, My GitHub accounts.
- **Preferences:** Appearance, Suggestions, Notes, Snoozing until activity, On this device (notifications and
  installing the app), Adventure mode.
- **Connections:** YouTube API key, Assistant: Anthropic API key, GitHub token, Post replies from Nudge.
- **Sync and data:** Syncing, Usage data, Version.

## Environment variables

All optional. The YouTube key and the Google OAuth client can also be given in Settings (they then live in the
database). For Docker, [`.env.example`](../.env.example) lists what `compose.yaml` passes through.

| Variable                                               | Meaning                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_API_KEY`                                      | YouTube Data API key (else Settings)                                                                                                                                                                                    |
| `NUDGE_PORT`                                           | API port, default `4517`                                                                                                                                                                                                |
| `NUDGE_HOST`                                           | Listen address, default `127.0.0.1`                                                                                                                                                                                     |
| `NUDGE_DB`                                             | SQLite path, default `data/nudge.db` (`:memory:` only in demo mode: a real server refuses to start with it)                                                                                                             |
| `NUDGE_ACCESS_HOSTS`                                   | Comma-separated hostnames behind Cloudflare Access, see [Security model](SECURITY-MODEL.md)                                                                                                                             |
| `NUDGE_ACCESS_TEAM_DOMAIN`, `NUDGE_ACCESS_AUD`         | The Access team domain (`<team>.cloudflareaccess.com`) and the application's audience tag                                                                                                                               |
| `NUDGE_ALLOWED_USERS`                                  | Comma-separated emails allowed in through Access (required with `NUDGE_ACCESS_HOSTS`)                                                                                                                                   |
| `NUDGE_GOOGLE_CLIENT_ID`, `NUDGE_GOOGLE_CLIENT_SECRET` | OAuth client for posting replies (else Settings)                                                                                                                                                                        |
| `NUDGE_PUSH_SUBJECT`                                   | Contact `mailto:` sent to push services, default `mailto:nudge@example.invalid`                                                                                                                                         |
| `NUDGE_WEB_DIR`                                        | Built web UI to serve, relative to the repository (default `dist/web`)                                                                                                                                                  |
| `GIT_SHA`                                              | Commit shown in Settings > Version. `npm run build` reads it from git when unset; the Docker build cannot see git, so export it (`deploy/update.sh` does), or it shows `dev`                                            |
| `NUDGE_BACKUP_DIR`                                     | Off-box directory for `deploy/backup.sh` (host side, see [Deploying](DEPLOYING.md#docker--cloudflare-access))                                                                                                           |
| `NUDGE_BUILD_STALL_SECS`, `NUDGE_BUILD_TIMEOUT`        | Host side, for `deploy/update.sh`: stop a build that prints nothing for this many seconds (default `300`) or runs past this `timeout` duration (default `25m`); see [Deploying](DEPLOYING.md#docker--cloudflare-access) |
| `NUDGE_UID`, `NUDGE_GID`                               | Host side, for `compose.yaml`: the user the container runs as, default `1000` for both; they must own `./data` (see [Deploying](DEPLOYING.md#a-host-user-that-is-not-uid-1000))                                         |
| `NUDGE_DEMO`                                           | `1`: demo mode, a fake world with no keys or network (refuses a database that holds real sources)                                                                                                                       |
| `NUDGE_DEMO_GITHUB`, `NUDGE_DEMO_COMMENTS`             | Demo: a fake GitHub organisation; give some of its items comment threads                                                                                                                                                |
| `NUDGE_DEMO_SUGGEST`, `NUDGE_DEMO_SUGGEST_CAP_AFTER`   | Demo: fake suggestions; make the daily cost cap bite after N calls                                                                                                                                                      |
| `NUDGE_DEMO_HISTORY`, `NUDGE_DEMO_BACKLOG`             | Demo: weeks of made-up history for Insights; N extra inbox items                                                                                                                                                        |
| `NUDGE_DEMO_POST=api`                                  | Demo: fake a connected Google account, so replies "post"                                                                                                                                                                |
| `NUDGE_DEMO_CLOCK=fixed`, `NUDGE_DEMO_BUILD_ID`        | Demo: the world stops growing on its own; claim a different web build (both for the e2e tests)                                                                                                                          |
| `E2E_PORT_OFFSET`, `NUDGE_SHOTS`                       | Tests: shift every e2e port (see [Development](DEVELOPMENT.md#end-to-end-tests)); a directory for the specs' screenshots                                                                                                |
| `ANTHROPIC_API_KEY`                                    | Only for `npm run eval:classify`; the app's own Anthropic key is entered in Settings                                                                                                                                    |

GitHub and Anthropic tokens for the app are entered in Settings only, and so is the owner profile (**Settings > You >
About you**, stored as the `owner` row of the `settings` table: `{"name": "...", "about": "..."}`; name 1-60
characters, about 1-1500, an empty string clears a part). `NUDGE_ALLOWED_HOSTS`, from when Tailscale was a way in, is
no longer read; Nudge starts anyway and logs a warning naming it.
