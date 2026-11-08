# Nudge

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

An API key is read from `YOUTUBE_API_KEY`, then the Settings screen, then `~/.nudge-key`.
On first run, paste your channel URL or @handle when asked (or under **Settings > My channels**): comments by it
are never inbox items, a reply from it auto-clears older comments in the same thread, and its uploads are tracked.
Ticking "This is my channel" when adding a channel source does exactly the same thing.

## Replying

By default Nudge only has an API key, which YouTube restricts to reading. `⌘/Ctrl+Enter` in the composer then
copies your reply, opens the comment on YouTube (`&lc=` permalink) and marks it replied (`z` undoes). This hand-off
is always the fallback: it is used until you connect a Google account, and again if the sign-in lapses.

### Replying from the app (optional)

Connect your Google account and `⌘/Ctrl+Enter` posts the reply straight to YouTube (`comments.insert`, 50 quota
units) as your channel, with no copy and paste. One-time Google Cloud setup, in the same project as your API key:

1. Open https://console.cloud.google.com and pick the project that holds your YouTube API key from the project
   picker in the top bar.
2. Check that **APIs & Services > Library > YouTube Data API v3** says "Enabled". It already should be.
3. Go to **Google Auth Platform** (left menu, or search "OAuth consent"). If you see **Get started**, click it:
   - App name: `Nudge`. User support email: your address.
   - **Audience: External.** "Internal" only exists for Workspace organisations.
   - Contact email: your address. Tick the policy box, then **Create**.
4. **Data Access > Add or remove scopes.** Filter for `youtube.force-ssl`, tick `.../auth/youtube.force-ssl`
   ("See, edit, and permanently delete your YouTube videos, ratings, comments and captions"), then
   **Update > Save**. Add no other scopes.
5. **Audience > Test users > Add users.** Add the Google account that owns or manages your channel (for a Brand
   Account channel, the Google account you sign in with), then **Save**.
6. **Avoid signing in again every week:** still under **Audience**, click **Publish app > Confirm**. Status becomes
   "In production". Ignore any "needs verification" notice: an app used only by you (fewer than 100 users) is
   exempt. In "Testing" status Google expires your sign-in every 7 days and Nudge falls back to copy-and-open
   until you reconnect.
7. **Clients > Create client.** Application type **Desktop app**, name `Nudge local`, **Create**, then
   **Download JSON**. No redirect URI is needed: Nudge always uses `http://127.0.0.1:4517/api/auth/callback`
   (or your `NUDGE_PORT`).
8. Give Nudge the client in any one of these ways:
   - paste the downloaded JSON into **Settings > Reply from Nudge**;
   - save it as `~/.nudge-google-client.json` and run `chmod 600` on it;
   - set `NUDGE_GOOGLE_CLIENT_ID` and `NUDGE_GOOGLE_CLIENT_SECRET`.
9. **Settings > Connect Google account.** Choose the account, then the channel if Google asks (Brand Accounts are
   listed separately). On "Google hasn't verified this app", click **Advanced > Go to Nudge (unsafe)**: it is
   your own app. On the permissions screen, **tick the YouTube box**. Google lets you untick it, and then posting
   cannot work.
10. You are sent back to Settings showing "Connected as <channel>". `⌘/Ctrl+Enter` now posts directly.

Notes:

- **`redirect_uri_mismatch` at step 9:** your client was created as "Web application". Either recreate it as
  Desktop app, or add exactly `http://127.0.0.1:4517/api/auth/callback` under **Authorized redirect URIs**.
- **Token storage:** your refresh token lives in `data/nudge.db` (mode 600, gitignored), at the same trust level
  as the stored API key. **Disconnect** in Settings revokes it at Google and deletes it.
- Posting is a manual action, so it may use the manual quota reserve. If a post fails because the sign-in expired
  or quota ran out, the composer offers Copy & open instead; a failed post keeps your draft.
- `z` after posting only moves the original comment back to the inbox; your reply stays on YouTube. Delete it with
  the explicit **Delete reply** button on the comment.
- Replies on videos you do not own are posted as your default connected channel.
- `NUDGE_DEMO_POST=api` (with `NUDGE_DEMO=1`) fakes a connected Google account and posts into the demo data,
  for trying the flow without Google.

## Keys (press `?` in the app for the full list)

| Key                                      | Action                                           | Key         | Action                               |
| ---------------------------------------- | ------------------------------------------------ | ----------- | ------------------------------------ |
| `j` / `k`                                | next / previous                                  | `e` / `d`   | done                                 |
| `m`                                      | mark replied (no reply)                          | `u`         | back to list (from the thread)       |
| `z`                                      | undo                                             | `r`         | reply                                |
| `x`, `J`/`K`                             | multi-select                                     | `* a` `* n` | select all / none                    |
| `Shift+U`                                | move back to inbox                               | `v` / `V`   | open comment / video on YouTube      |
| `Shift+N` / `S`                          | sync now / deep-sync video                       | `/`         | search                               |
| `b`                                      | snooze… (`1`-`4` presets, `5` pick a time)       | `l`         | label as… (type to filter or create) |
| `g i`, `g d`, `g a`, `g s`, `g t`, `g ,` | go to Inbox, Done, All, Sources, Stats, Settings | `Ctrl+K`    | command palette                      |
| `g z`                                    | go to Snoozed                                    | `g l`       | go to label… (picker)                |

Snoozing hides a comment until the time you pick; it returns to the top of the Inbox (a "back from snooze" marker
shows for a day), and `z` undoes it. In the Snoozed view `Shift+U` unsnoozes. Labels (managed in Settings) are
orthogonal to Inbox/Done: each gets a sidebar folder showing every comment carrying it, in any state.

Every triage action also has a button (thread header, row hover, multi-select bar, sidebar sync) whose tooltip
shows the hotkey, read from the same keymap registry.

## Quota

The API allows 10,000 units/day. Sync is incremental and tiered by video age (hot videos every 10 min, old ones
every 48 h); the Sources screen projects daily usage and the sidebar shows today's spend. Background polling
stops at budget minus a manual reserve.

## Development

`npm test` (vitest), `npm run test:e2e` (Playwright, demo data), `npm run typecheck`, `npm run format`.
Design notes: [docs/PLAN.md](docs/PLAN.md). OAuth posting design: [docs/OAUTH-PLAN.md](docs/OAUTH-PLAN.md).
Known limitations: held-for-review comments are still invisible (viewing them needs OAuth reads, deferred), liking
or hearting comments is not possible through the API, editing a posted reply is not supported, and deleted comments
are not detected.

## Deploying (Docker + Tailscale)

One box on your LAN runs the container; `tailscale serve` puts HTTPS in front of it, reachable only from your tailnet
(phone included). The app listens on the host's loopback only and still checks Host, Origin and, optionally, your
Tailscale identity. It has no password of its own, so do not publish the port anywhere else.

```shell
git clone git@github.com:mattgodbolt/nudge.git ~/nudge && cd ~/nudge
mkdir -p data
cat > .env <<EOF2
NUDGE_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net
NUDGE_ALLOWED_USERS=<your tailscale login>
YOUTUBE_API_KEY=<your key>     # the container cannot see ~/.nudge-key; or paste it into Settings
EOF2
docker compose up -d --build            # the image build runs the unit tests
tailscale serve --bg --https=443 http://127.0.0.1:4517
deploy/install-cron.sh                  # auto-update + nightly backup
```

- **Auto-update:** `deploy/update.sh` (cron, every 5 minutes) fetches `origin/main`; on a new commit it takes a backup,
  builds (a failing test aborts the build and the old container keeps running), restarts, and rolls back to the
  previous image if the new one is not healthy within ~90s. A commit that fails is remembered and not retried. See
  `data/update.log`.
- **Backups:** `deploy/backup.sh` (cron, 03:15) snapshots the live database with SQLite's online backup API, verifies
  it, keeps 7 in `data/backups/` and 14 on the NAS (`NUDGE_BACKUP_DIR`, default `/nas/BackedUp/nudge`). It exits
  non-zero if the NAS copy fails. Restore: stop the container, copy a snapshot over `data/nudge.db`, delete
  `nudge.db-wal`/`-shm`, start it. Snapshots contain your Google token and API key, so keep them private.
- **Google sign-in** redirects to `http://127.0.0.1:4517/...`, which only works on the machine itself. Connect once
  with `ssh -L 4517:127.0.0.1:4517 <box>` and open `http://127.0.0.1:4517/settings` (the tokens then live in the
  database), or connect on your laptop and copy the database across.

## Install on your phone and get notifications

Nudge is an installable web app (PWA) that can send Web Push notifications, with no native app involved.

A tab that has been in the background catches up on its own when you return to it (and reloads itself if a newer
version was deployed meanwhile). You can also refresh by hand: the circular-arrow button in the header, `Shift+R`, or
pull the list down on a touch screen.

1. On the phone (connected to your tailnet), open the HTTPS address in Chrome. Menu → **Install app**, or use the
   **Install as an app** button in Settings → Notifications.
2. Open **Settings → Notifications → Turn on for this device**, allow notifications, then **Send a test**.
3. Choose what you want: new comments and/or snoozed comments coming back. Settings are per device.

How it works:

- The server generates a VAPID key pair on first start (stored in the database) and sends each message, encrypted
  end to end, to your browser's push service (Google's FCM for Chrome). The server needs outbound HTTPS to that
  service; the phone does **not** need the tailnet to _receive_ a notification, only to open the page when you tap it
  (an always-on Tailscale VPN makes that invisible).
- New-comment notifications are batched for ~20 seconds, so one sync is one notification ("5 new comments", or the
  comment itself if there is one). A sync only finds comments as often as it polls the YouTube API, so that is how
  fresh a notification can be. Comments older than 48 hours are never announced (a new source's history, or a slow
  video's old finds). Snooze wake-ups go out immediately.
- If Nudge is open and in view on the device, the notification is skipped.
- A device is dropped automatically when its push service says it is gone. `NUDGE_PUSH_SUBJECT` (default
  `mailto:nudge@example.invalid`) is the contact URL sent to push services; set it to a real `mailto:` if you like.
- Restoring a database backup keeps your subscriptions only if the backup is recent; otherwise a device re-registers
  itself the next time you open Settings.

## Naming

The app was called Youtubey. Existing setups keep working: `YOUTUBEY_*` environment variables, `~/.youtubey-key` and
`~/.youtubey-google-client.json` are still read when the `NUDGE_*` / `~/.nudge-*` equivalents are absent, and
`data/youtubey.db` is moved to `data/nudge.db` automatically on first start.
