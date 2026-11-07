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

By default Youtubey only has an API key, which YouTube restricts to reading. `⌘/Ctrl+Enter` in the composer then
copies your reply, opens the comment on YouTube (`&lc=` permalink) and marks it replied (`z` undoes). This hand-off
is always the fallback: it is used until you connect a Google account, and again if the sign-in lapses.

### Replying from the app (optional)

Connect your Google account and `⌘/Ctrl+Enter` posts the reply straight to YouTube (`comments.insert`, 50 quota
units) as your channel, with no copy and paste. One-time Google Cloud setup, in the same project as your API key:

1. Open https://console.cloud.google.com and pick the project that holds your YouTube API key from the project
   picker in the top bar.
2. Check that **APIs & Services > Library > YouTube Data API v3** says "Enabled". It already should be.
3. Go to **Google Auth Platform** (left menu, or search "OAuth consent"). If you see **Get started**, click it:
   - App name: `Youtubey`. User support email: your address.
   - **Audience: External.** "Internal" only exists for Workspace organisations.
   - Contact email: your address. Tick the policy box, then **Create**.
4. **Data Access > Add or remove scopes.** Filter for `youtube.force-ssl`, tick `.../auth/youtube.force-ssl`
   ("See, edit, and permanently delete your YouTube videos, ratings, comments and captions"), then
   **Update > Save**. Add no other scopes.
5. **Audience > Test users > Add users.** Add the Google account that owns or manages your channel (for a Brand
   Account channel, the Google account you sign in with), then **Save**.
6. **Avoid signing in again every week:** still under **Audience**, click **Publish app > Confirm**. Status becomes
   "In production". Ignore any "needs verification" notice: an app used only by you (fewer than 100 users) is
   exempt. In "Testing" status Google expires your sign-in every 7 days and Youtubey falls back to copy-and-open
   until you reconnect.
7. **Clients > Create client.** Application type **Desktop app**, name `Youtubey local`, **Create**, then
   **Download JSON**. No redirect URI is needed: Youtubey always uses `http://127.0.0.1:4517/api/auth/callback`
   (or your `YOUTUBEY_PORT`).
8. Give Youtubey the client in any one of these ways:
   - paste the downloaded JSON into **Settings > Reply from Youtubey**;
   - save it as `~/.youtubey-google-client.json` and run `chmod 600` on it;
   - set `YOUTUBEY_GOOGLE_CLIENT_ID` and `YOUTUBEY_GOOGLE_CLIENT_SECRET`.
9. **Settings > Connect Google account.** Choose the account, then the channel if Google asks (Brand Accounts are
   listed separately). On "Google hasn't verified this app", click **Advanced > Go to Youtubey (unsafe)**: it is
   your own app. On the permissions screen, **tick the YouTube box**. Google lets you untick it, and then posting
   cannot work.
10. You are sent back to Settings showing "Connected as <channel>". `⌘/Ctrl+Enter` now posts directly.

Notes:

- **`redirect_uri_mismatch` at step 9:** your client was created as "Web application". Either recreate it as
  Desktop app, or add exactly `http://127.0.0.1:4517/api/auth/callback` under **Authorized redirect URIs**.
- **Token storage:** your refresh token lives in `data/youtubey.db` (mode 600, gitignored), at the same trust level
  as the stored API key. **Disconnect** in Settings revokes it at Google and deletes it.
- Posting is a manual action, so it may use the manual quota reserve. If a post fails because the sign-in expired
  or quota ran out, the composer offers Copy & open instead; a failed post keeps your draft.
- `z` after posting only moves the original comment back to the inbox; your reply stays on YouTube. Delete it with
  the explicit **Delete reply** button on the comment.
- Replies on videos you do not own are posted as your default connected channel.
- `YOUTUBEY_DEMO_POST=api` (with `YOUTUBEY_DEMO=1`) fakes a connected Google account and posts into the demo data,
  for trying the flow without Google.

## Keys (press `?` in the app for the full list)

| Key                                      | Action                                           | Key         | Action                          |
| ---------------------------------------- | ------------------------------------------------ | ----------- | ------------------------------- |
| `j` / `k`                                | next / previous                                  | `e` / `d`   | done                            |
| `m`                                      | mark replied (no reply)                          | `u`         | back to list (from the thread)  |
| `z`                                      | undo                                             | `r`         | reply                           |
| `x`, `J`/`K`                             | multi-select                                     | `* a` `* n` | select all / none               |
| `Shift+U`                                | move back to inbox                               | `v` / `V`   | open comment / video on YouTube |
| `Shift+N` / `S`                          | sync now / deep-sync video                       | `/`         | search                          |
| `g i`, `g d`, `g a`, `g s`, `g t`, `g ,` | go to Inbox, Done, All, Sources, Stats, Settings | `Ctrl+K`    | command palette                 |

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
