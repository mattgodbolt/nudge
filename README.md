# Nudge

A local, keyboard-driven triage inbox. It pulls in the comments on your YouTube videos (and on videos you merely
appear in), new pull requests and issues from GitHub accounts and organisations you follow, and your own todos, so
all of them are cleared the same way: read, reply, snooze, done.

Nudge is a personal tool for one person, not a SaaS. There are no accounts and no multi-user mode: it runs on your own
machine (or a box of your own behind Cloudflare Access), and keeps its data in a local SQLite file.

![The inbox: YouTube comments, each with a suggestion, and the open one beside the list](docs/screenshots/inbox.png)

## What it does

- **YouTube:** track channels, playlists and individual videos; every new comment lands in the inbox. Reply from the
  keyboard (copy-and-open, or post directly once you connect a Google account). See [YouTube](docs/YOUTUBE.md).
- **GitHub:** follow a user or organisation; new PRs and issues arrive with who opened them (team, contributor,
  first-timer, outsider, bot), the live conversation thread, and mute rules. See [GitHub](docs/GITHUB.md).
- **Todos:** "Tell Nudge" (`c`) turns a sentence, typed or dictated, into a todo, or snoozes or completes the selected
  item. See [Tell Nudge](docs/ASSISTANT.md).
- **Triage tools:** done, snooze, undo for everything, multi-select, search, filters, sort orders, a command
  palette, and a quota meter for the YouTube API. See [Keys](docs/KEYBOARD.md).
- **Phone and notifications:** an installable PWA with Web Push. See [Install on your phone](docs/PHONE.md).
- **Insights:** the top of Stats answers "when does stuff arrive, what do I do with it, and how good are the
  suggestions?": heatmaps of arrivals and of your triage, response times, what happens to things, reply rates, snooze
  habits, how often the robot agreed with you, the noisiest repos and videos, the backlog by age and over time, and a
  one-line summary of the week. Read-only, local, every number with its sample size, and "not enough data yet" until
  there is. See [docs/INSIGHTS.md](docs/INSIGHTS.md).
- **Stats and usage:** per-source video and comment totals, plus private counters of which features you use. See
  [Private data](docs/PRIVATE-DATA.md).
- **Adventure mode:** a purely cosmetic level, silly title, loot, bosses, achievements and a campfire, earned from the
  triage you have already done, in the sidebar and in the Hall of Heroes under Stats. It never changes how anything
  works, and one switch in Settings turns it off. See [docs/RPG.md](docs/RPG.md).
- **Demo mode:** a complete fake world, with no API keys or network, for trying it out.

## Quick start

Needs Node 22 or later.

```shell
npm install
npm run demo     # fake data, no API key needed: http://127.0.0.1:5173
npm run dev      # the real thing (API on :4517, Vite on :5173)
npm start        # production build served from :4517
```

`npm install` may ask you to allow the install scripts of `better-sqlite3` and `esbuild`; see
[Installing](docs/DEVELOPMENT.md#installing) for why, and for what a platform with no prebuilt SQLite module needs.

`npm run demo` keeps its data in `data/demo.db` and refuses to start against a database that holds real sources.
`NUDGE_DEMO_GITHUB=1` adds a fake GitHub organisation to it. Data lives in `data/nudge.db` (gitignored) unless
`NUDGE_DB` says otherwise.

`npm run dev` and `npm run demo` both use ports 4517 and 5173, so run one at a time (Ctrl-C stops both). `npm start`
is the one to run on your own machine for daily use; it needs no Cloudflare, but it has no login of its own, so
leave it bound to the loopback address and do not expose the port.

A real instance needs:

- **For YouTube, a YouTube Data API v3 key** (free), given as `YOUTUBE_API_KEY` or in Settings. GitHub-only use needs
  no YouTube key. [Getting a key](docs/YOUTUBE.md#getting-a-key-and-naming-your-channel) also covers telling Nudge
  which channel is yours.
- **For the model features (suggestions, nudge drafts, the assistant), an Anthropic key and the About you profile.**
  Fill in **Settings > You > About you**: what to call you, and a factual sentence or two about who you are and what
  you maintain. Every prompt is built from it, so until both are filled in Nudge makes no model calls at all, Settings
  says the LLM features are paused, and the server logs a warning at startup. Everything else works without it. Demo
  mode comes with a made-up profile.

## How it works

Nudge polls the sources you add: YouTube channels, playlists and videos through the YouTube Data API, with your own
key and within its daily quota, and GitHub users and organisations through GitHub's API, read-only. Todos come from
you.

Everything new becomes an item in one inbox, cleared with the same keys whatever it came from: done, reply, snooze
(for a time, or until someone acts), mute. A finished item comes back when there is new activity on it.

It is one Node process serving the web app and its API, and everything (items, your decisions, settings and keys)
lives in one SQLite file on your machine. Nudge has no service or account of its own; it talks only to YouTube,
GitHub and, if you turn the model features on, Anthropic. Use it in a browser on the same machine, or put it somewhere
you can reach from your phone: [Deploying](docs/DEPLOYING.md) lists the ways.

The model features are optional. With an Anthropic key and the About you profile, a small model suggests what to do
with each item, drafts follow-ups and understands Tell Nudge commands, within a daily cost cap. Without them,
everything else works the same.

## Configuration

Everything is optional, and every variable is listed in [docs/CONFIGURATION.md](docs/CONFIGURATION.md), along with
what lives in Settings and the demo and test switches.

**Basics.** `NUDGE_PORT` (default `4517`), `NUDGE_HOST` (default `127.0.0.1`), `NUDGE_DB` (default `data/nudge.db`)
and `NUDGE_WEB_DIR` (the built web UI, default `dist/web`). Everything works with none of them set.

**Keys.** `YOUTUBE_API_KEY` and the Google OAuth client for posting replies (`NUDGE_GOOGLE_CLIENT_ID`,
`NUDGE_GOOGLE_CLIENT_SECRET`) can be environment variables or entered in Settings; the variable wins. The Anthropic
key and the GitHub token are entered in Settings only. There are no key files any more.

**Putting it on the internet.** Only needed if you expose Nudge beyond your own machine: `NUDGE_ACCESS_HOSTS`,
`NUDGE_ACCESS_TEAM_DOMAIN` and `NUDGE_ACCESS_AUD` describe the Cloudflare Access application in front of it, and
`NUDGE_ALLOWED_USERS` the emails it lets in. See the [security model](docs/SECURITY-MODEL.md).

**Backups.** `NUDGE_BACKUP_DIR` is where `deploy/backup.sh` puts an off-box copy; unset means no off-box copy.

**Push.** `NUDGE_PUSH_SUBJECT` is the contact sent to push services with each notification.

**Build info.** `GIT_SHA` is the commit shown in Settings; the build reads it from git when unset.

## Documentation

- [Configuration](docs/CONFIGURATION.md): every variable, what lives in Settings, and which wins.
- [Security model](docs/SECURITY-MODEL.md): how requests are checked, and your data and third parties.
- [Deploying](docs/DEPLOYING.md): ways to run it, Docker behind Cloudflare Access, auto-update and backups.
- [YouTube](docs/YOUTUBE.md): the API key, replying (and posting from the app), quota and known limitations.
- [GitHub](docs/GITHUB.md): feeds, the token, who opened it, the conversation, muting and polling.
- [Tell Nudge](docs/ASSISTANT.md): todos and voice commands.
- [Keys](docs/KEYBOARD.md): the keyboard, snoozing until activity and selecting several items.
- [Phone](docs/PHONE.md): installing the app and push notifications.
- [Private data](docs/PRIVATE-DATA.md): the usage counters and habit context Nudge keeps for you alone.
- [Insights](docs/INSIGHTS.md): what the top of Stats shows and how it is worked out.
- [Adventure mode](docs/RPG.md): the cosmetic level, loot and campfire.
- [Development](docs/DEVELOPMENT.md): the code's layout, tests and the offline triage tooling.
- [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md): how to send a change or report a problem.
- Design history: [the original build plan](docs/PLAN.md) (historical), [OAuth posting](docs/OAUTH-PLAN.md), and
  proposals (partly historical) for [sources](docs/DESIGN-SOURCES.md) and [LLM triage](docs/DESIGN-LLM-TRIAGE.md).

## License

[MIT](LICENSE). Some of the icons are copied or adapted from [Feather](https://github.com/feathericons/feather)
(MIT, Cole Bemis): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
