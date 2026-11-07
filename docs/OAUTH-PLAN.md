# Plan: Google OAuth for posting YouTube replies from Youtubey

The plan builds on the existing `ReplyPoster` seam (`server/reply/poster.ts`), selected in `server/index.ts`. Routes stay the same, and the UI changes are limited to Settings, `web/src/lib/reply.ts`, the composer wording and one new SSE event.

## 0. What I found in the code (constraints that shape the plan)

- **Security guard (`server/security.ts`):**
  - Every request must have a loopback `Host` with the exact port.
  - Non-GET requests also need a same-host Origin (or a Vite dev origin) and `X-Youtubey: 1`.
  - GET requests only get the Host check. So a top-level GET from Google back to `http://127.0.0.1:4517/api/auth/callback` already passes; CSRF protection there has to come from the OAuth `state` value.
- **Capabilities only reach the browser through `/api/bootstrap`** (`web/src/lib/stores/app.svelte.ts`). There is no event that pushes them, so connecting, disconnecting or a revoked token needs a new SSE event.
- **What a sent reply does today:**
  - `reply.ts` already has an api-mode branch: optimistic `'replied'`, `drafts.hold`, and on failure `drafts.restore`.
  - `inbox.applyOptimistic` shows a generic error toast ("Could not update: …"); it needs a custom error hook.
  - `Composer.svelte` already switches its label on `postMode`.
- **Repo:**
  - `markHandedOff` = save draft `handed_off` + `triage([id], 'replied')`.
  - `drafts.status` already allows `'posted'`.
  - `addReplies(threadId, [YtComment])` inserts a comment as `own` if `authorChannelId` is in `ownChannelIds`, then runs `applyOwnReplies` (auto-clear of older non-user inbox comments).
  - Undo window is 24 h.
- **Migrations:** `MIGRATIONS[]`, `user_version` is 2, so the next one is index 2 → version 3.
- **DB permissions:** the DB and its WAL/SHM files are chmod 600; `*.db` and `data/` are gitignored.
- **YouTube client (`server/youtube/client.ts`):**
  - `normComment` is private. Export it so the poster can normalise the comment that `comments.insert` returns.
  - `mapApiError` is in `errors.ts`.
  - Requests go through `fetchImpl` (injectable), which makes fake-Google tests easy.
- **Quota:** `quota.charge(endpoint, units)` / `canManual()` / `blockUntilNextDay()` already exist.

## 1. Verified facts (web research, Nov 2026)

- **Desktop apps are "public clients"** (Google installed-app guide): PKCE is "always" recommended, with S256 and an explicit `code_challenge_method=S256`.
  - `client_secret` is listed as optional for desktop clients, but send it anyway. It is not really secret.
  - Refresh tokens are always returned for installed apps.
  - Token endpoint: `https://oauth2.googleapis.com/token`. Revoke endpoint: `https://oauth2.googleapis.com/revoke?token=…`.
  - `invalid_grant` on refresh means the token expired or was revoked, so the user must sign in again.
- **Loopback redirect:** the form is `http://127.0.0.1:<port>`; Google suggests 127.0.0.1 over `localhost` because of firewall issues.
  - The Desktop client type keeps loopback support (it is being dropped for iOS, Android and Chrome clients).
  - **Not confirmed in today's docs:** whether a Desktop client accepts any loopback port without registering it. The Desktop client has no redirect-URI field, and libraries like InstalledAppFlow use random ports, so it is very likely, but the first connect will confirm it.
  - Fallback: a "Web application" client. Google allows `http://127.0.0.1` / `localhost` redirect URIs for web clients, but each one must be registered exactly, port included.
- **Testing status:**
  - The app is limited to 100 test users.
  - "Test authorizations expire seven days after consent", and the refresh token expires with them, unless the only scopes are openid/email/profile. `youtube.force-ssl` triggers the 7-day expiry.
  - Pressing **Publish app** ("In production") removes the 7-day expiry.
- **Verification:**
  - "Personal use" apps with fewer than 100 users are exempt from mandatory verification.
  - Users "will be allowed to click through 'unverified app' warning screens".
  - Unverified apps with sensitive scopes are capped at 100 users over the project's lifetime, which doesn't matter here.
  - "Internal" audience only works inside a Workspace or Cloud Identity organisation, so it is not available to a personal Gmail account.
- **Scope:** `youtube.force-ssl` is the scope `comments.insert` needs. Several secondhand sources call it sensitive (not restricted); I found no official classification. Either way it means the unverified-app screen, not a hard block.
- **Limits:** 100 refresh tokens per Google account per client ID. Each new one silently invalidates the oldest, which is irrelevant here.
- **Quota costs:**
  - 50 units each: `comments.insert`, `comments.update`, `comments.setModerationStatus`, `comments.delete`, `commentThreads.insert`.
  - 1 unit each: `comments.list`, `commentThreads.list`, `channels.list`.
  - Quota is per Cloud project, so create the OAuth client in the same project as the API key. The app's ledger then matches Google's 10k/day pool.
- **`comments.insert`:** `part=snippet`, body `{snippet:{parentId, textOriginal}}`. Comments are "top-level, or a reply to a top-level comment", so `parentId` must be the top-level comment id (= thread id). Documented errors:
  - 400: `commentTextRequired`, `commentTextTooLong`, `invalidCustomEmoji`, `invalidCommentMetadata`, `operationNotSupported` (check `canReply`), `parentCommentIsPrivate`, `parentIdMissing`, `processingFailure`.
  - 403: `forbidden`, `ineligibleAccount` (no YouTube channel merged).
  - 404: `parentCommentNotFound`.
  - Plus the generic `quotaExceeded`, `rateLimitExceeded`, 401 and `insufficientPermissions`.
- **Moderation:**
  - `commentThreads.list` has `moderationStatus=heldForReview|likelySpam|published` (default `published`). It works only in an authorised request and can't be combined with `id`.
  - `comments.snippet.moderationStatus` is returned only to the channel/video owner, so held comments are invisible to API-key access.
  - `comments.setModerationStatus` (published/rejected, optional `banAuthor`) and `comments.delete` exist.
  - There is no API to like or heart a comment (`canRate`/`viewerRating` are read-only fields).
- **Node:** Node ≥22 has global `fetch` and `node:crypto` (`randomBytes`, `createHash('sha256')`). A hand-rolled PKCE flow is about 150 lines with no dependencies. `google-auth-library` would pull in gaxios, gtoken, jws and more just to do two POSTs. **Recommendation: hand-roll.**

## 2. One-time Google Cloud setup (README checklist)

Add this to README under "Replying from the app (optional)". Use the same Google Cloud project as your API key.

1. Open https://console.cloud.google.com and pick the project that holds your YouTube API key from the project picker in the top bar.
2. Check that **APIs & Services → Library → YouTube Data API v3** says "Enabled". It already should be.
3. Go to **Google Auth Platform** (left menu, or search "OAuth consent"). If you see **Get started**, click it:
   - App name: `Youtubey`. User support email: your address.
   - **Audience: External.** "Internal" only exists for Workspace organisations.
   - Contact email: your address. Tick the policy box, then **Create**.
4. **Data Access → Add or remove scopes.** Filter for `youtube.force-ssl`, tick `…/auth/youtube.force-ssl` ("See, edit, and permanently delete your YouTube videos, ratings, comments and captions"), then **Update → Save**. Add no other scopes.
5. **Audience → Test users → Add users.** Add the Google account that owns or manages your channel (for a Brand Account channel, the Google account you sign in with), then **Save**.
6. **Avoid signing in again every week:** still under **Audience**, click **Publish app → Confirm**. Status becomes "In production".
   - Ignore any "needs verification" notice. An app used only by you (fewer than 100 users) is exempt.
   - In "Testing" status, Google expires your sign-in every 7 days and Youtubey falls back to copy-and-open until you reconnect.
7. **Clients → Create client.**
   - Application type: **Desktop app**. Name: `Youtubey local`. Click **Create**, then **Download JSON**.
   - No redirect URI is needed. Youtubey always uses `http://127.0.0.1:4517/api/auth/callback`, or your `YOUTUBEY_PORT`.
8. Give Youtubey the client in any one of these ways:
   - paste the downloaded JSON into **Settings → Reply from Youtubey**;
   - save it as `~/.youtubey-google-client.json` and run `chmod 600` on it;
   - set `YOUTUBEY_GOOGLE_CLIENT_ID` and `YOUTUBEY_GOOGLE_CLIENT_SECRET`.
9. **Settings → Connect Google account.**
   - Choose the account, then the channel if Google asks (Brand Accounts are listed separately).
   - On "Google hasn't verified this app", click **Advanced → Go to Youtubey (unsafe)**. It is your own app.
   - On the permissions screen, **tick the YouTube box**. Google lets you untick it, and then posting cannot work.
10. You are sent back to Settings showing "Connected as <channel>". `⌘/Ctrl+Enter` now posts directly.

**Troubleshooting note (README):** if step 9 shows `redirect_uri_mismatch`, your client was created as "Web application". Either recreate it as Desktop app, or add exactly `http://127.0.0.1:4517/api/auth/callback` under **Authorized redirect URIs**.

**Dev vs prod:** the redirect always goes straight to the API server port (4517 or `YOUTUBEY_PORT`), never to Vite's 5173. After the callback the server sends the browser back to whichever UI origin started the flow. So `npm run dev` and `npm start` use the same redirect URI, and Vite's `/api` proxy is not involved.

## 3. Server design

### 3.1 Config (`server/config.ts`)

- Add `envGoogleClientId`, `envGoogleClientSecret` (from `YOUTUBEY_GOOGLE_CLIENT_ID` / `_SECRET`) and `googleClientFile` (`~/.youtubey-google-client.json`) to `Config`.
- Add `resolveGoogleClient(config, repo)`, mirroring `resolveApiKey`.
  - Order: env > settings (DB) > file.
  - Returns `{clientId, clientSecret, source} | null`.
  - It parses the downloaded file shape `{installed:{client_id, client_secret}}` and also accepts `{web:{…}}` or a flat `{client_id, client_secret}`.
- `StoredSettings` gains `googleClient: {clientId, clientSecret} | null`, with default `null` in the repo's `DEFAULT_SETTINGS`.
- The secret is never serialised to clients.

### 3.2 Migration 003 (append to `MIGRATIONS`)

```sql
CREATE TABLE google_accounts (
  channel_id TEXT PRIMARY KEY, channel_title TEXT, channel_thumb TEXT,
  refresh_token TEXT NOT NULL, access_token TEXT, access_expires_at TEXT,
  scope TEXT NOT NULL, connected_at TEXT NOT NULL,
  needs_reauth INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE reply_posts (
  id INTEGER PRIMARY KEY, comment_id TEXT NOT NULL, body_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','posted','failed','unknown')),
  posted_comment_id TEXT, via_channel_id TEXT, error TEXT, created_at TEXT NOT NULL);
CREATE INDEX idx_reply_posts_comment ON reply_posts(comment_id, created_at DESC);
```

- `google_accounts` is keyed by channel so several channels can be connected. v1 supports this cheaply (see 3.6).
- **Token storage:** plaintext in the 0600 SQLite file, the same trust level as the API key already stored there.
  - A file kept separately with mode 0600 adds nothing.
  - An OS keychain needs a native dependency (`keytar` is archived; libsecret bindings would be new) for a single-user, loopback-only app.
  - README note: "your refresh token lives in data/youtubey.db (mode 600); Disconnect revokes it at Google."

### 3.3 Auth module (`server/auth/google.ts`, new, no dependencies)

```ts
export interface GoogleAuth {
  status(): GoogleAuthDTO;
  start(returnOrigin: string): { url: string }; // creates pending state
  handleCallback(q: { code?; state?; error? }): Promise<{ returnTo: string }>;
  getAccessToken(channelId?: string): Promise<{ token: string; channelId: string }>; // refreshes, single-flight
  disconnect(channelId?: string): Promise<void>; // revoke + delete row
  setDefault(channelId: string): void;
}
```

- **Options:** `{ repo, getClient: () => resolveGoogleClient(...), redirectUri: () => string, fetchImpl, clock, onChange: () => void }`. `onChange` emits `capabilities.changed` and `settings.changed`.
- **`start`:**
  - `state = base64url(randomBytes(32))`, `verifier = base64url(randomBytes(48))` (64 chars), `challenge = base64url(sha256(verifier))`.
  - Pending entries live in an in-memory `Map<state, {verifier, returnOrigin, createdAt}>`, with a 10-minute TTL, at most 5 entries, and single use.
  - Auth URL `https://accounts.google.com/o/oauth2/v2/auth` with: `client_id`, `redirect_uri`, `response_type=code`, `scope=https://www.googleapis.com/auth/youtube.force-ssl`, `state`, `code_challenge`, `code_challenge_method=S256`, `access_type=offline`, `prompt=consent select_account`.
  - `prompt=consent` ensures a fresh refresh token on reconnect; `access_type` is harmless for Desktop clients and required for Web clients.
- **`handleCallback`:**
  1. Look up and delete `state`. If it is unknown or expired, fail with `bad_state`.
  2. If `error` is set (for example `access_denied`), fail with `denied`.
  3. POST the token endpoint (`grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`, `client_secret`).
  4. Check that the returned `scope` includes `youtube.force-ssl`. If not (granular consent unticked), fail with `scope_missing`.
  5. Call `channels.list?part=snippet&mine=true` with a Bearer token (1 unit, charged to quota). If there are no items, fail with `no_channel` (`ineligibleAccount` case).
  6. Upsert the `google_accounts` row; the first account becomes default.
  7. **Ownership:** `setOwnChannelId(repo, channelId, true)` and `recomputeOwnership`. This is required, otherwise the posted reply arrives as a non-own inbox item and auto-clear never fires. If `ownChannelIds` was empty, also `deps.addSource(channelId, {isOwn:true, importMode:'recent'})`, which replaces the manual handle step.
  8. Call `onChange()`.
- **`getAccessToken`:**
  - Return the cached token if `access_expires_at - now > 60 s`.
  - Otherwise refresh. Use one in-flight promise per channel so concurrent posts share one refresh.
  - `invalid_grant` (or 400/401 from the token endpoint) sets `needs_reauth = 1`, stores `last_error`, calls `onChange()` and throws `PostError('auth_required')`.
- **`disconnect`:** best-effort POST to `/revoke?token=<refresh>` (ignore network errors), delete the row, call `onChange()`. Own-channel registration stays; the channel is still yours.
- **`redirectUri()`:** `http://127.0.0.1:${actualListeningPort}/api/auth/callback`. Pass a getter into `buildApp`, because `index.ts` only knows the port after `listen` (tests use port 0).

### 3.4 Routes (`server/routes/auth.ts`, new; registered in `server/app.ts`)

| Route                                     | Guard                                                                                                   | Behaviour                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/status`                    | Host                                                                                                    | Returns `GoogleAuthDTO`.                                                                                                                                                                                                                                                                          |
| `POST /api/auth/start`                    | Host, Origin and X-Youtubey (existing)                                                                  | Body `{}`. `returnOrigin` = request `Origin` if it equals the Host origin or is in `devOrigins()`, else `http://<Host>`. Returns `{url}`. Returns 400 `no_client` if no client is configured.                                                                                                     |
| `GET /api/auth/callback?code&state&error` | Host only (it is a browser navigation from accounts.google.com; no Origin or custom header is possible) | Responds with a 302 to `${returnOrigin}/settings?google=connected` or `?google=<errorcode>`. Unknown state → 302 to `/settings?google=bad_state` on its own host, never to an attacker-chosen origin. Sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer` so the code doesn't leak. |
| `POST /api/auth/logout`                   | full                                                                                                    | Body `{channelId?}`. Revokes and returns `GoogleAuthDTO`.                                                                                                                                                                                                                                         |
| `POST /api/auth/default`                  | full                                                                                                    | Body `{channelId}`. Optional, only when several accounts are connected.                                                                                                                                                                                                                           |
| `PUT /api/settings`                       | existing                                                                                                | Accepts `googleClient: {json?: string} \| {clientId, clientSecret} \| null`. Validation: `clientId` ends with `.apps.googleusercontent.com`.                                                                                                                                                      |

**Why the GET callback is safe:**

- The side effect needs a `state` that only a POST carrying X-Youtubey could create. That POST is unreachable cross-site, which stops login-CSRF (being tricked into connecting an attacker's account).
- `state` is 256-bit, single-use and expires after 10 minutes.
- The PKCE verifier never leaves the server, so a leaked code is useless.
- The Host check still blocks DNS rebinding.
- `returnOrigin` comes from the trusted start request, not from the callback, so there is no open redirect.
- No `security.ts` change is needed. Add a test that pins this behaviour.

### 3.5 Shared contract changes (lead-owned)

- `shared/types.ts`:

  ```ts
  export interface GoogleAccountDTO {
    channelId: string;
    title: string | null;
    thumbnailUrl: string | null;
    connectedAt: string;
    needsReauth: boolean;
    lastError: string | null;
    isDefault: boolean;
  }
  export interface GoogleAuthDTO {
    clientConfigured: boolean;
    clientSource: 'env' | 'settings' | 'file' | null;
    redirectUri: string;
    accounts: GoogleAccountDTO[];
  }
  ```

- `SettingsDTO` gains `google: GoogleAuthDTO`, so the existing `settings.changed` event carries it.
- `Capabilities` stays `{canPost, postMode}`. Optionally add `postAs: {channelId, title} | null` for the composer label.
- `ServerEvent` gains `| { type: 'capabilities.changed'; capabilities: Capabilities }`.
- `SettingsUpdate` gains `googleClient?`.
- `shared/api.ts` documents the new routes and new error codes: `auth_required`, `quota_exhausted`, `cannot_reply`, `comment_gone`, `text_too_long`, `ineligible_account`, `duplicate_in_flight`, `post_unconfirmed`.

### 3.6 `ApiPoster` and the switching poster (`server/reply/poster.ts`)

- `createReplyPoster({repo, auth, quota, handoff, api})`:
  - `capabilities()` returns `{canPost:true, postMode:'api'}` when the client is configured and at least one account has `!needsReauth`; otherwise it returns the handoff capabilities.
  - `reply()` delegates the same way. If `capabilities()` says `handoff`, the client already ran the gesture path. If capabilities flip between the client's bootstrap and the POST, the server returns `auth_required` instead of silently recording a hand-off.
- `index.ts` builds it.
- **Demo mode:** a `fakeGoogleAuth` that is "connected" as the demo own channel, plus a `postReply` on the fake client that appends to the world. This keeps e2e coverage of api mode, behind `YOUTUBEY_DEMO_POST=api` so existing e2e runs stay in handoff mode.

**`ApiPoster.reply(comment, body)`:**

1. **Validate:**
   - `text = body.trim()`; reject 1..10000 chars (YouTube's limit, matching the composer counter).
   - `parentId = comment.parentId ?? comment.id`; assert it equals `comment.threadId`.
   - Load the thread; if `!canReply`, fail with `cannot_reply` before spending 50 units.
2. **Prevent double posting:**
   - An in-memory `Map<commentId, Promise<ReplyResult>>`: a second call while one is in flight gets 409 `duplicate_in_flight`. Not the same promise, so the UI does not toast twice.
   - DB: if `reply_posts` has a `posted` row for this `comment_id` with the same `sha256(text)` from the last 10 minutes, return the recorded result without calling YouTube.
   - Then insert `reply_posts(status='pending')`.
3. **Quota:** if `!quota.canManual()`, return 429 `quota_exhausted`. Posting is a manual action, so it may use the reserve. Then `quota.charge('comments.insert', 50)`.
4. **Pick the identity:**
   - the connected account whose `channel_id` equals the video's `channelId`;
   - otherwise the default account (videos you merely appear in);
   - `getAccessToken(channelId)`.
5. **Call** `POST https://www.googleapis.com/youtube/v3/comments?part=snippet` with `Authorization: Bearer` and JSON `{snippet:{parentId, textOriginal:text}}`. No `key` parameter. 15-second timeout via `AbortSignal.timeout`.
6. **On success:**
   - `normComment(raw, comment.videoId, parentId)` (export it from `client.ts`).
   - If `authorChannelId` is not in `ownChannelIds`, register it as a safety net.
   - New `repo.recordPostedReply(commentId, text, posted: YtComment)`, in one transaction:
     - `saveDraft(commentId, text, 'posted')`;
     - `triage([commentId], 'replied')`, which is `state_source='user'` and the undoable action;
     - `addReplies(threadId, [posted])`, which inserts it as `own` and auto-clears older thread comments;
     - mark `reply_posts` as `posted`.
   - Return `{mode:'posted', comment: repo.getComment(posted.id)!, actionId}`.
   - The route emits `inbox.changed` with the target, auto-cleared ids and `addedIds:[posted.id]`. Extend the route's `emitInbox` call to take the ids from the result. The open thread view then refreshes.
7. **Error mapping:** add a `PostError` class with `{code, status, message, retryable}`, mapped in the route like `YtError`.

| Google response                                                                                | Our code (HTTP)                  | Side effect                                                | Client offers                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| refresh `invalid_grant`, 401, 403 `insufficientPermissions`                                    | `auth_required` 401              | `needs_reauth=1`, `capabilities.changed` (back to handoff) | **Reconnect** (go to Settings) and **Copy & open** |
| 403 `quotaExceeded` / `dailyLimitExceeded`                                                     | `quota_exhausted` 429            | `quota.blockUntilNextDay()`                                | **Copy & open**                                    |
| 429 / 403 `rateLimitExceeded`, `userRateLimitExceeded`                                         | `rate_limited` 429               | none                                                       | **Retry**                                          |
| 400 `operationNotSupported`, 403 `forbidden`, `commentsDisabled`, 400 `parentCommentIsPrivate` | `cannot_reply` 422               | `operationNotSupported` sets `threads.can_reply=0`         | **Copy & open**                                    |
| 404 `parentCommentNotFound`                                                                    | `comment_gone` 404               | none                                                       | **Done** (mark done)                               |
| 400 `commentTextTooLong` / `commentTextRequired` / `invalidCustomEmoji` / `processingFailure`  | `text_too_long` / `bad_text` 400 | none                                                       | edit, draft restored                               |
| 403 `ineligibleAccount`                                                                        | `ineligible_account` 403         | none                                                       | Settings link                                      |
| 5xx, timeout, network after send                                                               | verify first (below)             | none                                                       | **Retry**, warning that it may already be posted   |

**Ambiguous failures:** `insert` is not idempotent, so never auto-retry a 5xx or timeout.

- Instead call `comments.list?part=snippet&parentId=<parentId>&maxResults=20` (1 unit, OAuth). Look for a comment by our channel with `publishedAt >= startedAt - 5 s` and matching text (compare `htmlToPlain(textDisplay)` normalised to `text`).
- If found, treat it as success (step 6).
- If not found, `reply_posts.status='failed'` and return a 502 `post_failed`, retryable.
- If the verification itself fails, `status='unknown'`, return `post_unconfirmed`, and the client warns "may have posted; check on YouTube" with an **Open** action.
- Only `ECONNREFUSED`/DNS errors (the request never left) are retried automatically, once.

The route (`/api/comments/:id/reply`) is otherwise unchanged. It already calls `poster.reply` and emits.

### 3.7 Settings DTO

`buildSettingsDto` adds `google: auth.status()`. `AppDeps` gains `auth: GoogleAuth` (required; the handoff-only and demo variants provide stubs).

## 4. UI changes

### 4.1 `SettingsView.svelte`: new "Reply from Youtubey" card, placed after the API key card

**State A, no client configured:**

- One sentence on what this enables, and a link to the README checklist.
- A textarea: "Paste the downloaded client JSON" → **Save**. If the client comes from env or file, show its source like the API-key card does.
- The redirect URI is shown read-only with a copy button, for the Web-client fallback.

**State B, client configured but no account:**

- A **Connect Google account** button calls `api.authStart()` and then `window.location.assign(url)`. Use the same tab: simpler than a popup, and the page reboots on return.
- **Remove client** if the client came from settings.

**State C, connected:**

- For each account: avatar, title, "Connected <date>", a default radio when there is more than one, and **Disconnect** (with a confirm).
- If `needsReauth`: a red line "Google sign-in expired or was revoked" and a **Reconnect** button. If the app is still in Testing status, add the hint "publish the app (README step 6) to stop weekly expiry".
- An **Add another channel** link.

**On load:** read `?google=` from `router.query` and toast the result: connected, or a specific error message for `denied`, `scope_missing`, `no_channel`, `bad_state`, `token_exchange_failed`. Then clear the query. A one-line `router.svelte.ts` tweak may be needed for this.

**Other places:**

- `settings.svelte.ts`: `connectGoogle()`, `disconnectGoogle(id)`, `saveGoogleClient(json)`.
- `api.ts`: `authStatus`, `authStart`, `authLogout`, `authDefault`.
- `sse.ts`: handle `capabilities.changed` by setting `settings.capabilities = e.capabilities` (and add it to `TYPES`).

### 4.2 Composer and `web/src/lib/reply.ts` in api mode

- **Wording:** `Composer.svelte` hint becomes "`⌘↵` post as <channel>" and the button "Reply". This already switches on `postMode`; only the label text changes. Keep the **Copy** button.
- **Add a "Copy & open instead" link** in api mode, calling a new `handoff(item, body)` exported from `reply.ts`. This is today's handoff branch extracted into a function, so the gesture rule still holds.
- **Posting state:** keep today's optimistic flow (the item leaves the inbox at once, which keeps keyboard triage fast). `reply.ts` api branch:
  - module-level `inflight = new Set<string>()`; return early if `inflight.has(id)`. This is the client-side double-press guard. Composer `doSend` already closes and blurs, so a second `⌘↵` can't hit the composer scope, but this also covers the button.
  - A sticky info toast "Posting reply…", replaced on resolution by "Reply posted as <channel> · z moves it back to inbox", with an **Open** action (permalink of the new comment from `result.comment.permalink`).
- **Errors:** extend `inbox.applyOptimistic` opts with `onError?: (e: ApiRequestError) => void`, used instead of the generic toast. The rollback and `drafts.restore` already exist. `reply.ts` maps `e.code` to the actions in the table in 3.6:
  - `auth_required` → "Google sign-in expired", with Reconnect and Copy & open;
  - `quota_exhausted`/`cannot_reply` → Copy & open;
  - `rate_limited`/`post_failed` → Retry (re-calls `send`);
  - `post_unconfirmed` → Open on YouTube, and do not restore the draft as unsent.
  - Copy & open from a toast button click is a user gesture, so clipboard and `window.open` still work.
- **Undo (decision):** a reply posted through the API is **not** deleted by `z`. `z` only undoes the triage action, moving the comment back to inbox, as now. The toast wording makes that explicit.
  - Deleting is an explicit, separate action: a **Delete reply** button on own comments that were posted from Youtubey (have a `reply_posts` row), with a confirm. It calls `comments.delete` (50 units).
  - Rationale: a silent API delete on `z` is surprising, costs 50 units, and races with people who have already seen the reply.
  - A Gmail-style "undo send" delay is listed in section 7 as a choice for you.

## 5. Extras: include now vs defer

**Include in this work (cheap, and they make OAuth correct):**

- Automatic detection of your channel with `channels.list mine=true` on connect, registered as yours, and tracked if you have no own channel yet. Onboarding (`settings.needsOwnChannel`) can then show "or Connect Google account" as an alternative to typing a handle.
- Delete your own reply (`POST /api/comments/:id/delete`, own and app-posted only), which also removes the local row.
- Several connected channels, picked by the video's owner channel. The schema is already keyed by channel.

**Defer to a follow-up (the design is ready for it):**

- **Held-for-review / likely-spam inbox:** `commentThreads.list?allThreadsRelatedToChannelId=<own>&moderationStatus=heldForReview` with OAuth (1 unit per page, poll every 30 minutes). It needs:
  - a `comments.moderation_status` column and a new "Held" view;
  - approve and reject actions (`setModerationStatus`, 50 units each; reject can optionally ban the author);
  - the engine's `YouTubeClient` to take an optional bearer token.

  This removes the README's "held comments are invisible" limitation, but it touches sync, the schema, views and keymap, so it gets its own chunk.

- Editing your own reply (`comments.update`, 50 units).
- Using OAuth for all reads, which would drop the API-key requirement. Quota is the same project pool either way, and the key keeps sync working when OAuth lapses, so it isn't worth it now.
- Not possible through the API: liking or hearting comments.

## 6. Test plan (no real network)

**`server/auth/google.test.ts`** with a fake `fetchImpl` that routes on `oauth2.googleapis.com/token`, `/revoke` and `youtube/v3/channels`:

- The `start` URL contains every required parameter; the challenge equals `base64url(sha256(verifier))`.
- State is single-use, expires (injected clock), and the pending map is capped.
- Callback paths: happy path stores tokens, registers ownership and calls `onChange`; `error=access_denied`; scope missing; `channels` returns zero items.
- Refresh: cached token reused; refresh at the 60-second boundary; one fetch for N concurrent refreshes; `invalid_grant` sets `needs_reauth` and emits.
- Disconnect revokes and deletes; a revoke network failure still deletes.
- Resolution order for the client: env > settings > file, with JSON shape parsing (`installed`, `web`, flat).

**`server/reply/poster.test.ts`** with an in-memory DB (`openRepo(':memory:')`), a fake fetch and a fake quota:

- Insert body and endpoint: `parentId` equals the thread id for both a top-level target and a reply target; Bearer header present; no `key` parameter; 50 units charged.
- Success: target becomes `replied` (`state_source` user), the posted comment is inserted as `own`, older inbox comments in the thread become `auto_replied`, draft becomes `posted`, the `actionId` undoes only the target.
- Duplicate in flight → 409. Same body within 10 minutes → no second fetch.
- Each row of the error table, including `blockUntilNextDay` on `quotaExceeded` and `can_reply=0` on `operationNotSupported`.
- Timeout followed by verification: found → success; not found → `post_failed`; verification throws → `post_unconfirmed`. Assert insert is never called twice.
- Switching poster: capabilities flip on `needsReauth`; `reply()` in api-capable mode with no valid token → `auth_required`, not a silent hand-off.

**`server/routes/auth.test.ts`** with `buildApp` and `app.inject`:

- The callback passes `security.ts` with a loopback Host and no X-Youtubey, and is rejected with Host `evil.com:4517`.
- `POST /start` without the header → 403.
- A dev Origin `http://127.0.0.1:5173` makes the callback redirect back to 5173; an unknown state redirects to its own host only.
- Callback responses carry `Cache-Control: no-store`.
- Extend `hardening.test.ts` so `/api/settings` and `/api/bootstrap` never contain `clientSecret`, `refresh_token` or `access_token` (string search in the JSON).

**Migration test:** opening a v2 DB migrates to v3 and `user_version` is 3.

**Web unit tests** (vitest and jsdom, like `inbox.svelte.test.ts`):

- `reply.ts` api branch: the inflight guard; `onError` maps codes to toast actions; draft restored on failure; draft not restored as unsent on `post_unconfirmed`.
- `sse` `capabilities.changed` updates the store.

**e2e** (Playwright, demo with `YOUTUBEY_DEMO_POST=api`):

- Composer shows "post as Demo Channel".
- `⌘↵` posts; the reply appears in the thread as own; `z` moves the target back to inbox while the reply stays.
- Settings card shows connected; Disconnect switches the composer to "Copy & open".

## 7. Work breakdown (after a short serial Step 0)

**Step 0 (lead, serial, small):**

- `shared/types.ts` and `shared/api.ts` additions (3.5); `server/contracts.ts`: `GoogleAuth` interface, `PostError`, `Repo.recordPostedReply`, `Repo` Google account CRUD, `StoredSettings.googleClient`, `AppDeps.auth`.
- Migration 003 appended to `server/db/migrations.ts`.
- `export normComment` in `server/youtube/client.ts`.

**Chunk A: auth core.** Owns:

- `server/auth/google.ts` (+ test), new;
- `server/config.ts` (`resolveGoogleClient`);
- `server/routes/auth.ts` (+ test), new;
- `server/app.ts` (register routes, `redirectUri` getter);
- `server/index.ts` wiring.

**Chunk B: repo and poster.** Owns:

- `server/db/repo.ts` (`google_accounts` CRUD, `reply_posts`, `recordPostedReply`, `googleClient` setting);
- `server/reply/poster.ts` (ApiPoster and switching poster, + test);
- `server/youtube/errors.ts` (comment-insert reasons);
- `server/routes/api.ts` (`PostError` mapping, `emitInbox` with result ids, `googleClient` in `PUT /settings`, delete-reply route);
- `server/routes/util.ts` (`buildSettingsDto.google`).

Works against the Step-0 `GoogleAuth` interface with a stub.

**Chunk C: web.** Owns:

- `web/src/views/SettingsView.svelte`, `web/src/lib/stores/settings.svelte.ts`, `web/src/lib/api.ts`, `web/src/lib/sse.ts`;
- `web/src/lib/reply.ts`, `web/src/components/Composer.svelte`;
- `web/src/lib/stores/inbox.svelte.ts` (`onError` opt only);
- the ThreadView "Delete reply" button;
- web unit tests.

**Chunk D: demo, e2e, docs.** Owns:

- `server/demo/fake-client.ts` / `world.ts` (`postReply`), a fake GoogleAuth (`server/demo/fake-auth.ts`, new);
- the `YOUTUBEY_DEMO_POST` handling in `index.ts`, coordinated with A (a one-line hook A leaves);
- `e2e/reply-api.spec.ts`;
- `README.md` (checklist in section 2, Replying section rewrite, known limitations);
- `docs/PLAN.md` (new section on OAuth, plus the reply seam update).

A, B and C run in parallel after Step 0. D starts in parallel but its e2e run needs B and C.

## 8. Risks and questions that need your decision

1. **Publish the consent screen, or reconnect weekly?** Publishing ("In production", unverified, personal use) is the only way to avoid the 7-day expiry for an External app. The cost is a one-time "Google hasn't verified this app" click-through. The plan assumes you publish; confirm that is acceptable.
2. **Which channel posts on videos you don't own?** That is, videos you appear in on someone else's channel. The plan uses the default connected account. The alternative is to fall back to copy-and-open for those videos. Pick one.
3. **Undo after posting.** The plan's choice: `z` only moves the comment back to inbox and leaves the reply on YouTube, with deletion as an explicit "Delete reply" button. If you would rather have a Gmail-style undo-send (posting delayed about 5 seconds, `z` cancels), say so. It needs a small server-side send queue and changes the toast and `ReplyResult` flow.
4. **Held-for-review inbox.** Ship it now as a fifth chunk, or defer it as planned? It is the biggest extra OAuth unlocks, and it touches sync, the schema and the views.

Technical risks the plan already handles (no decision needed):

- **Desktop client and any loopback port:** not explicitly confirmed in current docs. Mitigation: the fixed redirect URI plus the README fallback ("Web application" client with the exact URI).
- **Unticked YouTube box on the consent screen:** detected through the returned `scope`.
- **Posted reply arriving as an inbox item:** prevented by registering the connected channel as yours.
- **Ambiguous posting failures:** verify with a lookup, never retry blindly.
- **Quota:** each post costs 50 units from the same 10k/day pool, which is about 180 replies/day if nothing else ran. Posting uses `canManual()` and the reserve.

### Critical Files for Implementation

- /home/matthew/dev/youtubey/server/reply/poster.ts
- /home/matthew/dev/youtubey/server/contracts.ts
- /home/matthew/dev/youtubey/server/db/repo.ts
- /home/matthew/dev/youtubey/server/routes/api.ts (+ new /home/matthew/dev/youtubey/server/auth/google.ts and /home/matthew/dev/youtubey/server/routes/auth.ts)
- /home/matthew/dev/youtubey/web/src/lib/reply.ts and /home/matthew/dev/youtubey/web/src/views/SettingsView.svelte

Sources:

- [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [YouTube installed-apps auth guide](https://developers.google.com/youtube/v3/guides/auth/installed-apps)
- [OAuth 2.0 overview: refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Loopback IP address flow migration guide](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)
- [OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Manage app audience (Testing vs In production)](https://support.google.com/cloud/answer/15549945)
- [Unverified apps](https://support.google.com/cloud/answer/7454865)
- [Exceptions to verification requirements](https://support.google.com/cloud/answer/13464323)
- [comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert)
- [Comments resource](https://developers.google.com/youtube/v3/docs/comments)
- [commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list)
- [Quota cost table](https://developers.google.com/youtube/v3/determine_quota_cost)
- [Sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Phyllo: YouTube OAuth scopes](https://www.getphyllo.com/post/youtube-oauth-scopes) and [Scalekit: YouTube connector](https://www.scalekit.com/agent-connector/youtube) (secondhand only, for "force-ssl is sensitive")

## Decisions (confirmed by the user)

1. Publish the consent screen (no weekly reauth).
2. Default connected channel posts on videos you do not own.
3. z after posting only moves the comment back to inbox; explicit Delete reply button.
4. Held-for-review inbox deferred.
