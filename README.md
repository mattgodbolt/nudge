# Youtubey

A local, keyboard-driven inbox for the comments on your YouTube videos (and on videos you merely appear in).
Track channels, playlists and individual videos; every new comment lands in an inbox; reply or mark it done
without leaving the keyboard. Single user, runs on `127.0.0.1`, data in a gitignored SQLite file.

## Quick start

```shell
npm install
npm run demo     # fake data, no API key needed: http://127.0.0.1:5173
npm run dev      # the real thing (API on :4517, Vite on :5173)
npm start        # production build served from :4517
```

An API key is read from `YOUTUBE_API_KEY`, then the Settings screen, then `~/.youtubey-key`.
On first run, paste your channel URL or @handle when asked (or under **Settings > My channels**): comments by it
are never inbox items, a reply from it auto-clears older comments in the same thread, and its uploads are tracked.
Ticking "This is my channel" when adding a channel source does exactly the same thing.

## Replying

This version only uses an API key, which YouTube restricts to reading. `⌘/Ctrl+Enter` in the composer therefore
copies your reply, opens the comment on YouTube (`&lc=` permalink) and marks it replied (`z` undoes). The
`ReplyPoster` seam in `server/reply/poster.ts` is where OAuth posting (`comments.insert`) would plug in later.

## Keys (press `?` in the app for the full list)

| Key                               | Action                                    | Key         | Action                          |
| --------------------------------- | ----------------------------------------- | ----------- | ------------------------------- |
| `j` / `k`                         | next / previous                           | `e` / `d`   | done                            |
| `m`                               | mark replied (no reply)                   | `u`         | back to list (from the thread)  |
| `z`                               | undo                                      | `r`         | reply                           |
| `x`, `J`/`K`                      | multi-select                              | `* a` `* n` | select all / none               |
| `Shift+U`                         | move back to inbox                        | `v` / `V`   | open comment / video on YouTube |
| `Shift+N` / `S`                   | sync now / deep-sync video                | `/`         | search                          |
| `g i`, `g d`, `g a`, `g s`, `g ,` | go to Inbox, Done, All, Sources, Settings | `Ctrl+K`    | command palette                 |

Every triage action also has a button (thread header, row hover, multi-select bar, sidebar sync) whose tooltip
shows the hotkey, read from the same keymap registry.

## Quota

The API allows 10,000 units/day. Sync is incremental and tiered by video age (hot videos every 10 min, old ones
every 48 h); the Sources screen projects daily usage and the sidebar shows today's spend. Background polling
stops at budget minus a manual reserve.

## Development

`npm test` (vitest), `npm run test:e2e` (Playwright, demo data), `npm run typecheck`, `npm run format`.
Design notes: [docs/PLAN.md](docs/PLAN.md). Known limitations: held-for-review comments are invisible to
API-key access, and deleted comments are not detected.
