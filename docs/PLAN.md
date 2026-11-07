# Youtubey implementation plan: from the Python CLI to a local keyboard-driven web app

## 0. Current state and environment

- Repo: `/home/matthew/dev/youtubey`. It contains `youtubey/main.py` (click CLI: `new-comments` keeps a JSON seen-set in `~/.youtubey-state.json`; `watch-counts` defaults to channel `UC9-y-6csu5WGm29I7JiwpnA`), `pyproject.toml`, `poetry.lock`, `README.md`, `.gitignore` (just `__pycache__`) and `.idea/`.
- Toolchain: Node v24.18.1 (nvm) and npm 11.16.0. The key file `~/.youtubey-key` exists. The old code does not trim the key, so the new code must `.trim()` it.
- Bugs and quota waste in the old code that the new code must not repeat:
  - On first run every comment is treated as new.
  - `watch-counts` calls `videos.list` once per video instead of batching 50 ids.
  - Replies are never fetched.
  - It never stops paginating, so every comment on every video is read on every run.

## 1. Prior art (brief)

Searches found nothing open source that combines a self-hosted web UI, a unified inbox across videos, and replying.

- **mattwright324/youtube-comment-suite** (Java, SQLite archive and search of video, playlist and channel comments). Borrow: comments stored in SQLite and searched locally, and treating channels, playlists and videos as "groups" of sources. Avoid: archive-everything full rescans and no triage state.
- **mint-youtube and the comment pickers.** These are analysis only. Nothing to borrow.
- **Comment bots.** Avoid entirely. Auto-posting risks YouTube ToS problems, which is another reason to keep the Phase 1 hand-off.
- **Superhuman, Hey and Linear inbox patterns** (borrow):
  - One list plus a detail pane.
  - `e` archives and the selection auto-advances to the next item.
  - `z` undoes, backed by a toast with an Undo button.
  - `g`-chords for navigation with a 1000 ms chord timeout (tinykeys default; 300 ms is called out as too fast).
  - Cmd/Ctrl+K command palette.
  - `?` overlay generated from the same registry as the palette, so the two never drift.
  - Inputs swallow single-key shortcuts except Esc and Mod+Enter.
- **tinykeys.** We will not take it as a dependency. We need scoped keymaps and an introspectable registry for help and the palette, and a ~150-line custom keymap is simpler than wrapping it. Copy its semantics: `$mod`, sequences, and ignoring editable targets.
- **YouTube API facts that matter** (from the commentThreads.list docs):
  - `allThreadsRelatedToChannelId` is still documented. It lists threads across all of a channel's videos for 1 unit per 100 threads, which is a big quota win for the own channel.
  - `order=time` is the default, but the docs do not say whether "time" means thread creation or latest reply. This needs a spike (risk R1).
  - Errors: `commentsDisabled` (403), `videoNotFound` / `channelNotFound` / `commentThreadNotFound` (404), `processingFailure` (400), `quotaExceeded` (403).
  - `part=replies` returns only a subset of replies, so use `comments.list?parentId=` (1 unit per 100) when `totalReplyCount` is larger than what came back inline.

## 2. Layout and tooling

```
/package.json              single package, "type":"module", engines.node ">=22"
/tsconfig.base.json        strict, ES2023, moduleResolution Bundler (web) / NodeNext (server), noUncheckedIndexedAccess
/tsconfig.json             project references -> server, web
/server/tsconfig.json      NodeNext, outDir ../dist/server, includes ../shared
/web/tsconfig.json         extends @tsconfig/svelte
/vite.config.ts            root: "web", outDir ../dist/web, dev proxy /api -> http://127.0.0.1:4517 (SSE included)
/vitest.config.ts          projects: "server" (env node, server/**/*.test.ts, shared/**), "web" (jsdom + @testing-library/svelte, web/**/*.test.ts)
/playwright.config.ts      webServer: `npm run demo:e2e`, baseURL http://127.0.0.1:4518
/eslint.config.js          flat config: typescript-eslint + eslint-plugin-svelte; /.prettierrc (+ prettier-plugin-svelte, printWidth 120)
/shared/types.ts           ALL domain + DTO types (contract, see section 5)
/shared/api.ts             route path constants, request/response type map, SSE event union
/shared/youtube-urls.ts    parseSourceInput(), permalink(videoId, commentId) - pure, shared by server and client
/server/index.ts           boot: config -> db -> youtube client (real|fake) -> engine -> scheduler -> app.listen
/server/config.ts          env + defaults, API-key resolution
/server/app.ts             buildApp(deps): FastifyInstance  (deps injected, used by tests via app.inject)
/server/security.ts        host/origin checks
/server/events/bus.ts
/server/db/{db.ts, migrate.ts, migrations/001_init.sql, repo.ts, repo.test.ts}
/server/youtube/{client.ts, http.ts, errors.ts, types.ts, fake.ts, fixtures/*.json, client.test.ts}
/server/sync/{engine.ts, scheduler.ts, quota.ts, tiers.ts, *.test.ts}
/server/reply/{poster.ts, handoff.ts}
/server/routes/{bootstrap,inbox,threads,triage,drafts,replies,sources,sync,settings,events}.ts
/server/demo/{generate.ts, seed.ts}
/web/index.html, /web/src/main.ts, /web/src/App.svelte
/web/src/lib/{api.ts, sse.ts, router.svelte.ts, reply.ts, sanitize.ts, format.ts}
/web/src/lib/keys/{keymap.svelte.ts, bindings.ts}
/web/src/lib/stores/{inbox,thread,sources,settings,sync,toasts,theme,selection}.svelte.ts
/web/src/components/{Shell,Sidebar,CommandPalette,HelpOverlay,Toasts,VirtualList,InboxRow,ThreadView,CommentCard,Composer,EmptyState,Kbd,SyncIndicator,QuotaMeter}.svelte
/web/src/views/{InboxView,SourcesView,SettingsView}.svelte
/web/src/styles/{tokens.css, base.css}
/e2e/*.spec.ts
/data/                     gitignored; youtubey.db (+ -wal/-shm), demo.db
```

**Dependencies**

- Runtime: `fastify`, `@fastify/static`, `better-sqlite3`, `dompurify`, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`.
- Dev: `typescript`, `tsx`, `vite`, `svelte@5`, `@sveltejs/vite-plugin-svelte`, `svelte-check`, `vitest`, `jsdom`, `@testing-library/svelte`, `@playwright/test`, `eslint`, `typescript-eslint`, `eslint-plugin-svelte`, `prettier`, `prettier-plugin-svelte`, `concurrently`, `@types/better-sqlite3`, `@types/node`.
- No `googleapis` package: we use plain `fetch` against `https://www.googleapis.com/youtube/v3`.
- No SvelteKit: a plain SPA with a tiny router.
- No Tailwind: plain CSS custom properties plus Svelte scoped styles.

**Scripts**

- `dev`: `concurrently -n api,web "tsx watch server/index.ts" "vite"`. The API listens on 127.0.0.1:4517 and Vite on 127.0.0.1:5173.
- `build`: `vite build && tsc -p server`
- `start`: `npm run build && node dist/server/index.js` (serves `dist/web` plus SPA fallback on 4517).
- `demo`: `YOUTUBEY_DEMO=1 YOUTUBEY_DB=data/demo.db npm run dev`
- `demo:e2e`: `YOUTUBEY_DEMO=1 YOUTUBEY_DB=:memory: YOUTUBEY_PORT=4518 YOUTUBEY_DEMO_CLOCK=fixed vite build && tsx server/index.ts`
- `test`: `vitest run`
- `test:e2e`: `playwright test`
- `typecheck`: `tsc -b && svelte-check`
- `lint`: `eslint . && prettier --check .`
- `format`: `prettier --write .`

**Housekeeping**

- Delete `youtubey/`, `pyproject.toml` and `poetry.lock`.
- Rewrite `README.md`.
- Add `node_modules`, `dist`, `data/`, `test-results`, `playwright-report` and `.env` to `.gitignore`.
- Leave `.idea/` alone.

## 3. SQLite schema (`server/db/migrations/001_init.sql`)

Migrations are tracked with `PRAGMA user_version`. On open, run `journal_mode=WAL`, `foreign_keys=ON` and `synchronous=NORMAL`. All timestamps are ISO-8601 UTC TEXT.

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);          -- JSON values
-- keys: apiKey, ownChannelIds (string[]), pollEnabled, dailyQuotaBudget (default 9000),
--       manualReserve (1000), backfillDays (14), theme ('system'|'light'|'dark')

CREATE TABLE sources (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('channel','playlist','video')),
  yt_id TEXT NOT NULL, title TEXT, thumbnail_url TEXT,
  is_own INTEGER NOT NULL DEFAULT 0,                 -- channel source flagged as "mine"
  uploads_playlist_id TEXT,                          -- for channels
  enabled INTEGER NOT NULL DEFAULT 1,
  import_mode TEXT NOT NULL DEFAULT 'recent' CHECK (import_mode IN ('none','recent','all')),
  added_at TEXT NOT NULL, membership_refreshed_at TEXT, last_error TEXT,
  UNIQUE (kind, yt_id));

CREATE TABLE videos (
  id TEXT PRIMARY KEY, channel_id TEXT, channel_title TEXT, title TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT, published_at TEXT, view_count INTEGER, comment_count INTEGER,
  meta_refreshed_at TEXT,
  -- sync state
  comments_disabled INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
  baseline_at TEXT,             -- comments published before this are imported as 'archived'
  last_synced_at TEXT, next_sync_at TEXT, last_deep_scan_at TEXT,
  error_count INTEGER NOT NULL DEFAULT 0, backoff_until TEXT, last_error TEXT,
  poll_tier TEXT                -- null = auto from published_at; else 'hot'|'warm'|'cold'|'paused'
);
CREATE TABLE source_videos (source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id), position INTEGER, PRIMARY KEY (source_id, video_id));
CREATE INDEX idx_videos_next ON videos(next_sync_at);

CREATE TABLE threads (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), channel_id TEXT,
  top_comment_id TEXT NOT NULL, total_reply_count INTEGER NOT NULL DEFAULT 0,
  fetched_reply_count INTEGER NOT NULL DEFAULT 0, can_reply INTEGER NOT NULL DEFAULT 1,
  last_activity_at TEXT NOT NULL, own_last_reply_at TEXT);
CREATE INDEX idx_threads_video ON threads(video_id, last_activity_at DESC);

CREATE TABLE comments (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id TEXT,               -- null for top-level
  video_id TEXT NOT NULL,
  author_name TEXT NOT NULL, author_channel_id TEXT, author_avatar_url TEXT,
  text_html TEXT NOT NULL, text_plain TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0, published_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  is_own INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('inbox','done','replied','auto_replied','own','archived')),
  state_changed_at TEXT NOT NULL, state_source TEXT NOT NULL CHECK (state_source IN ('sync','user','auto')));
CREATE INDEX idx_comments_state ON comments(state, published_at DESC);
CREATE INDEX idx_comments_thread ON comments(thread_id, published_at);
CREATE INDEX idx_comments_video ON comments(video_id, published_at DESC);

CREATE VIRTUAL TABLE comments_fts USING fts5(text_plain, author_name, content='comments', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
-- + AFTER INSERT/UPDATE/DELETE triggers keeping fts in sync

CREATE TABLE triage_actions (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, to_state TEXT NOT NULL,
  changes TEXT NOT NULL,        -- JSON [{commentId, from}]
  undone_at TEXT);

CREATE TABLE drafts (comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','handed_off','posted')));

CREATE TABLE quota_ledger (day_pt TEXT NOT NULL, endpoint TEXT NOT NULL, units INTEGER NOT NULL,
  calls INTEGER NOT NULL, PRIMARY KEY (day_pt, endpoint));
CREATE TABLE sync_runs (id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, scope TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, units INTEGER DEFAULT 0, videos INTEGER DEFAULT 0,
  new_comments INTEGER DEFAULT 0, error TEXT);
```

**State model.** The inbox unit is a single comment, either top-level or a reply. The detail pane shows the whole thread with the triggering comment highlighted.

- `inbox`: needs attention. Every new comment by someone other than the configured own channel(s) lands here, on every tracked source, own or not.
- `done`: the user dismissed it (`e`/`d`).
- `replied`: the user marked it as replied, or completed a hand-off or post through the composer.
- `auto_replied`: sync saw an own-channel comment in the same thread published after this comment.
- `own`: written by an own channel id. Never shown in the inbox.
- `archived`: baseline import of old comments when a source is added. Visible in "All" only.

**Views.** Inbox = `inbox`. Done = `done`, `replied` and `auto_replied`. All = everything except `own`.

**Undo.** Every state change made by the user writes a `triage_actions` row that records the previous state of each comment. `undo(actionId)` restores each `from` value, but only where the current state still equals `to_state`, so it never clobbers a later change. It sets `undone_at` and returns the changes. Only actions less than 24 h old can be undone. The UI keeps a stack of action ids for repeated `z`.

**Auto-clear rule** (`repo.applyOwnReplies(threadId)`, called after any thread upsert):

- `own_last_reply_at = max(published_at)` over comments where `is_own=1`.
- `UPDATE comments SET state='auto_replied', state_source='auto' WHERE thread_id=? AND state='inbox' AND published_at < own_last_reply_at`.
- `is_own` is computed at insert time as `author_channel_id IN ownChannelIds`.
- When `ownChannelIds` changes, recompute `is_own` and re-run auto-clear over all threads. Only `sync`/`auto` rows move back. User-set states are never touched.
- Auto-clear emits an `inbox.changed` event. Auto-cleared items show "Answered on YouTube" in the Done view.

**Baseline / backfill.** When a video is first attached to a source, set `videos.baseline_at` from the source's `import_mode`:

- `none`: the add time.
- `recent`: now minus `backfillDays` (default 14).
- `all`: the epoch.

Any comment first seen with `published_at < baseline_at` is inserted as `archived`. This stops a 5,000-comment flood on day one.

## 4. YouTube sync, quota and API key

**API key resolution**, in order:

1. env `YOUTUBE_API_KEY`
2. `settings.apiKey` (set from the Settings UI and stored in the gitignored DB)
3. `~/.youtubey-key` (trimmed)

Responses only ever expose `{configured, source:'env'|'settings'|'file'|null, last4}`. `POST /api/settings/test-key` performs a 1-unit `videos.list?id=jNQXAC9IVRw` call.

**Client** (`server/youtube/client.ts`) implements:

```ts
interface YouTubeClient {
  listCommentThreads(p: {
    videoId?: string;
    allThreadsRelatedToChannelId?: string;
    pageToken?: string;
  }): Promise<Page<YtThread>>; // part=snippet,replies maxResults=100 order=time textFormat=html, fields= trimmed
  listReplies(p: { parentId: string; pageToken?: string }): Promise<Page<YtComment>>; // comments.list part=snippet maxResults=100
  listPlaylistItems(p: {
    playlistId: string;
    pageToken?: string;
  }): Promise<Page<{ videoId: string; position: number }>>;
  getVideos(ids: string[]): Promise<YtVideo[]>; // chunks of 50, part=snippet,statistics
  getChannel(p: { id?: string; handle?: string }): Promise<YtChannel | null>; // part=snippet,contentDetails (uploads playlist)
  getPlaylist(id: string): Promise<YtPlaylist | null>;
}
```

- Every call goes through `http.ts`, which:
  - charges `quota.charge(endpoint, 1)` before the call;
  - retries 5xx and network errors with backoff of 1 s, 2 s and 4 s plus jitter (3 tries);
  - maps errors to `YtError {reason: 'quotaExceeded'|'commentsDisabled'|'notFound'|'forbidden'|'badRequest'|'keyInvalid'|'network'|'unknown'}` using `error.errors[0].reason`.
- Concurrency is capped at 4 in-flight requests (a simple semaphore).
- `fake.ts` implements the same interface on top of an in-memory world (section 7).

**Quota** (`server/sync/quota.ts`):

- The ledger is keyed by Pacific date (`Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'})`).
- `remaining()` = `dailyQuotaBudget - used`.
- The background scheduler stops once it hits `budget - manualReserve`. Manual sync may use the reserve.
- A `quotaExceeded` from the API sets `quotaBlockedUntil` to the next Pacific midnight, stops all sync and emits `quota.update`.

**Polling tiers** (`tiers.ts`). An automatic tier comes from the video's `published_at`. A per-video override is allowed.

| tier   | age     | interval | deep scan |
| ------ | ------- | -------- | --------- |
| hot    | < 3 d   | 10 min   | every 6 h |
| warm   | < 30 d  | 1 h      | daily     |
| cold   | < 365 d | 12 h     | weekly    |
| frozen | older   | 48 h     | monthly   |

- The sources screen shows a projected daily unit estimate, roughly the sum of `1440/interval × pagesTypical`.
- Example: 20 hot videos ≈ 2,880 units/day. That is fine, but the UI warns when the projection exceeds the budget.

**Own channel feed.** For each enabled `is_own` channel source, poll `commentThreads?allThreadsRelatedToChannelId=` every 10 min with incremental stop. One call covers new threads on all videos. Upsert the video row lazily, using a batched `videos.list` for unknown video ids. Per-video polling still runs for own videos, but at one tier colder, to catch replies to old threads.

**Membership refresh**:

- Playlists and uploads playlists are refreshed hourly. This is `playlistItems` at 1 unit per 50 items. Mark removed videos as no longer in the source but keep their data.
- Video metadata is refreshed daily through batched `videos.list`.
- Channel resolution: `@handle` → `channels.list?forHandle=`, and `UC…` → `channels.list?id=`. Both cost 1 unit.

**Incremental per-video sync** (`engine.syncVideo(videoId, {deep})`):

1. Skip the video if `comments_disabled` (recheck weekly), `missing`, or `backoff_until > now`.
2. Page through `commentThreads(videoId, order=time)`. For each thread:
   - upsert the thread and the top-level comment;
   - if the top-level comment is new, insert it with state `own`, `archived` or `inbox` (in that precedence);
   - if `totalReplyCount > stored.fetched_reply_count`: when the inline `replies.comments.length >= totalReplyCount`, upsert those; otherwise fetch `listReplies(parentId)` and upsert every page. New replies get the same state rules;
   - call `applyOwnReplies(threadId)`.
3. **Stop condition** (non-deep): stop after the first page in which every thread was already known and none had a changed `totalReplyCount`. Also stop when the last thread on the page has `publishedAt < baseline_at` and the video has been synced before. A deep scan walks every page. Deep scans are capped at 20 pages for videos with more than 2,000 comments; beyond that rely on `allThreadsRelatedToChannelId` (own channel) or accept the gap (risk R1).
4. On success: set `last_synced_at`, compute `next_sync_at` from the tier, and reset `error_count`.
5. Error handling:
   - `commentsDisabled`: set `comments_disabled=1`, `next_sync_at = +7d`.
   - `notFound`: set `missing=1`.
   - Anything else: `error_count++` and `backoff_until = now + min(2^n × 5 min, 24 h)`.
   - `quotaExceeded`: abort the whole run.
6. Wrap each video's writes in a single `db.transaction`.
7. Emit `sync.progress` after each video and `inbox.changed {added: n, counts}` at the end of each video (debounced 250 ms).

**Engine API**:

```ts
interface SyncEngine {
  run(req: {
    trigger: 'manual' | 'poll' | 'source-added';
    scope: 'all' | 'source' | 'video';
    id?: string | number;
    deep?: boolean;
  }): Promise<SyncRunSummary>;
  status(): SyncStatus;
}
```

- Only one run at a time. A manual request made during a background run is merged: queue the extra scope, and mark it high priority so it is taken next.
- The scheduler (`scheduler.ts`) ticks every 60 s. When `pollEnabled`, the key is configured and quota allows, it selects up to 25 due videos (`next_sync_at <= now ORDER BY next_sync_at`) plus due own-channel feeds and membership refreshes, then calls `run({trigger:'poll'})`.
- `s` (sync now) triggers `scope:'all'`, which syncs all enabled sources' due-or-not videos. Order: hot videos first, then everything else by `last_synced_at` ascending. The run stops if the reserve is exhausted.

## 5. Shared contract (`shared/types.ts`, `shared/api.ts`)

This file is the load-bearing interface. It is written first by the scaffold step and changed only through the lead.

```ts
export type CommentState = 'inbox' | 'done' | 'replied' | 'auto_replied' | 'own' | 'archived';
export type InboxView = 'inbox' | 'done' | 'all';
export type SourceKind = 'channel' | 'playlist' | 'video';
export type PollTier = 'hot' | 'warm' | 'cold' | 'frozen' | 'paused';

export interface CommentDTO {
  id: string;
  threadId: string;
  parentId: string | null;
  videoId: string;
  authorName: string;
  authorChannelId: string | null;
  authorAvatarUrl: string | null;
  textHtml: string;
  textPlain: string;
  likeCount: number;
  publishedAt: string;
  updatedAt: string;
  isOwn: boolean;
  state: CommentState;
  stateSource: 'sync' | 'user' | 'auto';
  permalink: string;
}
export interface VideoDTO {
  id: string;
  title: string;
  channelId: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  commentCount: number | null;
  commentsDisabled: boolean;
  missing: boolean;
  tier: PollTier;
  tierOverride: PollTier | null;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  inboxCount: number;
}
export interface InboxItem {
  comment: CommentDTO;
  video: Pick<VideoDTO, 'id' | 'title' | 'thumbnailUrl'>;
  parent: Pick<CommentDTO, 'id' | 'authorName' | 'textPlain' | 'isOwn'> | null; // context for replies
  threadReplyCount: number;
  hasDraft: boolean;
}
export interface ThreadDetail {
  threadId: string;
  video: VideoDTO;
  canReply: boolean;
  comments: CommentDTO[];
  /* top-level first then replies chronological */ totalReplyCount: number;
}
export interface SourceDTO {
  id: number;
  kind: SourceKind;
  ytId: string;
  title: string | null;
  thumbnailUrl: string | null;
  isOwn: boolean;
  enabled: boolean;
  importMode: 'none' | 'recent' | 'all';
  addedAt: string;
  videoCount: number;
  inboxCount: number;
  lastError: string | null;
  projectedUnitsPerDay: number;
}
export interface Counts {
  inbox: number;
  done: number;
  all: number;
  bySource: Record<number, number>;
}
export interface QuotaDTO {
  dayPt: string;
  used: number;
  budget: number;
  reserve: number;
  blockedUntil: string | null;
}
export interface SyncStatus {
  running: boolean;
  runId: number | null;
  trigger: string | null;
  done: number;
  total: number;
  currentVideoId: string | null;
  lastRun: SyncRunSummary | null;
}
export interface SyncRunSummary {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  units: number;
  videos: number;
  newComments: number;
  error: string | null;
}
export interface SettingsDTO {
  apiKey: { configured: boolean; source: 'env' | 'settings' | 'file' | null; last4: string | null };
  ownChannelIds: string[];
  pollEnabled: boolean;
  dailyQuotaBudget: number;
  manualReserve: number;
  backfillDays: number;
  theme: 'system' | 'light' | 'dark';
  demo: boolean;
}
export interface Capabilities {
  canPost: boolean;
  postMode: 'handoff' | 'api';
}
export interface TriageResult {
  actionId: number;
  changes: { commentId: string; from: CommentState; to: CommentState }[];
  counts: Counts;
}
export type ReplyResult = { mode: 'handoff'; url: string } | { mode: 'posted'; comment: CommentDTO };
export interface Bootstrap {
  settings: SettingsDTO;
  capabilities: Capabilities;
  counts: Counts;
  sources: SourceDTO[];
  quota: QuotaDTO;
  sync: SyncStatus;
}
export type ServerEvent =
  | { type: 'inbox.changed'; counts: Counts; addedIds: string[]; changedIds: string[] }
  | { type: 'sync.progress'; status: SyncStatus }
  | { type: 'sync.done'; summary: SyncRunSummary }
  | { type: 'quota.update'; quota: QuotaDTO }
  | { type: 'sources.changed'; sources: SourceDTO[] }
  | { type: 'settings.changed'; settings: SettingsDTO }
  | { type: 'error'; message: string; sourceId?: number; videoId?: string };
export interface ApiError {
  error: string;
  code: string;
}
```

**Routes** (`shared/api.ts` exports a `Routes` map from path to `{req, res}` types). All routes are JSON under `/api`.

| Method             | Path                       | Body / query                                                                                                    | Response                                                                                                                                                    |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                | /api/bootstrap             | –                                                                                                               | Bootstrap                                                                                                                                                   |
| GET                | /api/inbox                 | `view, sourceId?, videoId?, q?, cursor?, limit=100` (sort `published_at DESC, id`; cursor = opaque `publishedAt | id`)                                                                                                                                                        | `{items: InboxItem[]; nextCursor: string\|null; total: number}` |
| GET                | /api/threads/:threadId     | `?focus=commentId`                                                                                              | ThreadDetail                                                                                                                                                |
| POST               | /api/triage                | `{commentIds: string[]; to: 'done'\|'replied'\|'inbox'}`                                                        | TriageResult                                                                                                                                                |
| POST               | /api/triage/:actionId/undo | –                                                                                                               | TriageResult                                                                                                                                                |
| GET / PUT / DELETE | /api/drafts/:commentId     | PUT `{body}`                                                                                                    | `{body, updatedAt, status}` / 204                                                                                                                           |
| POST               | /api/comments/:id/reply    | `{body}`                                                                                                        | ReplyResult. Phase 1 records `drafts.status='handed_off'`, sets state `replied`, writes a triage action and returns `{mode:'handoff', url}` plus `actionId` |
| GET                | /api/sources               | –                                                                                                               | SourceDTO[]                                                                                                                                                 |
| POST               | /api/sources               | `{input: string; importMode?; isOwn?}`                                                                          | SourceDTO (201). Then a background `source-added` sync runs                                                                                                 |
| PATCH              | /api/sources/:id           | `{enabled?, isOwn?, title?, importMode?}`                                                                       | SourceDTO                                                                                                                                                   |
| DELETE             | /api/sources/:id           | `?purge=1` deletes videos/comments not referenced by another source                                             | 204                                                                                                                                                         |
| GET                | /api/sources/:id/videos    | –                                                                                                               | VideoDTO[]                                                                                                                                                  |
| PATCH              | /api/videos/:id            | `{tierOverride: PollTier\|null}`                                                                                | VideoDTO                                                                                                                                                    |
| POST               | /api/sync                  | `{scope, id?, deep?}`                                                                                           | 202 SyncStatus                                                                                                                                              |
| GET                | /api/sync/status           | –                                                                                                               | SyncStatus                                                                                                                                                  |
| GET                | /api/quota                 | –                                                                                                               | QuotaDTO                                                                                                                                                    |
| GET / PUT          | /api/settings              | PUT `Partial<SettingsDTO-ish> & {apiKey?: string\|null}`                                                        | SettingsDTO                                                                                                                                                 |
| POST               | /api/settings/test-key     | `{apiKey?}`                                                                                                     | `{ok: boolean; message: string}`                                                                                                                            |
| GET                | /api/events                | SSE (`text/event-stream`; `event: <type>`, `data: JSON`; 20 s `:ping`; `retry: 2000`)                           | –                                                                                                                                                           |

**Input parsing.** `parseSourceInput` in `shared/youtube-urls.ts` accepts:

- `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, and a bare 11-character id → video;
- `list=` or a bare `PL…`/`UU…`/`OL…` id → playlist;
- `/channel/UC…` or a bare `UC…` id → channel;
- `/@handle` or `@handle` → channel by handle.

A watch URL that contains both `v` and `list` resolves to the playlist. The UI shows that interpretation as a preview before confirming.

**Why SSE over websocket.** Updates only flow server to client, mutations already go over REST, Vite proxies SSE with no extra setup, and `EventSource` reconnects automatically. The client re-fetches bootstrap on reconnect.

**Security** (`server/security.ts`):

- Listen on `127.0.0.1` only.
- Reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS rebinding.
- For non-GET requests, require `Origin` to be absent or same-host, and require an `X-Youtubey: 1` header. The client sets it on every request, and it blocks cross-site form CSRF.
- Without these, any website could hit the unauthenticated API.

**Reply seam** (`server/reply/poster.ts`):

```ts
interface ReplyPoster {
  capabilities(): Capabilities;
  reply(comment: CommentDTO, body: string): Promise<ReplyResult>;
}
```

- Phase 1: `HandoffPoster` returns `{mode:'handoff', url: permalink}`.
- Phase 2: `ApiPoster` uses OAuth `youtube.force-ssl` plus `comments.insert {snippet:{parentId: threadId, textOriginal}}` and upserts the returned comment as `own`, which triggers auto-clear. It is selected by config and needs no route or UI changes.
- Client side (`web/src/lib/reply.ts`), `send(commentId, body)`:
  - If `capabilities.postMode==='handoff'`, it first calls `navigator.clipboard.writeText(body)` and `window.open(permalink,'_blank','noopener')` **synchronously inside the key or click handler**, so the browser's user-gesture requirements for clipboard and popups are met.
  - It then POSTs to `/reply` to record the result, and shows the toast "Copied and opened on YouTube · marked replied · z to undo".
  - If `api`, it awaits the POST.
  - The composer only ever calls `send`.

## 6. Frontend architecture (Svelte 5 runes, no SvelteKit)

**Router** (`router.svelte.ts`)

- History API routes: `/inbox`, `/done`, `/all`, `/sources`, `/sources/:id`, `/settings`.
- Query params `?source=&video=&q=&c=<commentId>` make the selection deep-linkable.
- The state is a `$state` object `{route, params, query}`, exposing `navigate()` and a `popstate` listener.

**Stores** (all `.svelte.ts` modules exporting class instances with `$state` fields and `$derived` getters)

- `inbox`:
  - Fields: `items`, `view`, `filters`, `selectedIndex`, `selectedIds` (a Set for multi-select), `loading`, `nextCursor`, `counts`.
  - Methods: `load()`, `loadMore()`, `move(±1)`, `select(id)`, `toggleSelect()`, `extendSelection(±1)`, `triage(to)`, `undo()`, `applyServerEvent(e)`.
  - `triage` is optimistic. It removes the targets when the view excludes the new state, moves the selection to the next item (or the previous one at the end), adjusts counts, then POSTs. On success it pushes `actionId` onto `undoStack` and shows a toast with Undo. On failure it restores items and indices and shows an error toast.
  - `inbox.changed` from SSE: if the user is at the top of the list and not composing, prepend the new items (fetch first page and merge by id). Otherwise show a "N new · press . to show" pill, to avoid moving the list under the cursor.
- `thread`: fetches `ThreadDetail` for the selected item and caches it in an LRU of 50. It prefetches the next item's thread on selection to make j/k feel instant.
- `drafts`: autosaves the composer body with `PUT` debounced at 500 ms and keeps a local mirror. Drafts survive navigation.
- `sources`, `settings`, `sync` (status and quota), `theme` (persisted in settings, applied as `data-theme` on `<html>`, `system` follows `matchMedia`), and `toasts` (`push({message, action?, timeoutMs=6000})`).

**`sse.ts`.** A single `EventSource('/api/events')` dispatches typed events to the stores. On reconnect it calls `bootstrap()` to resync.

**Keyboard layer** (`keys/keymap.svelte.ts`)

```ts
type Scope = 'global' | 'list' | 'thread' | 'composer' | 'palette' | 'help' | 'modal';
interface Binding {
  id: string;
  keys: string[]; /* e.g. ['j','ArrowDown'], ['g i'], ['$mod+k'] */
  scope: Scope;
  group: 'Navigation' | 'Triage' | 'Reply' | 'Go to' | 'App';
  description: string;
  when?: () => boolean;
  run: (e: KeyboardEvent) => void;
  palette?: boolean; /* default true */
}
export const keymap: {
  register(b: Binding | Binding[]): () => void;
  pushScope(s: Scope): () => void;
  activeScopes: Scope[];
  pendingChord: string | null;
  all(): Binding[];
};
```

- There is one `keydown` listener on `window`.
- Key normalization: `$mod` = Meta on macOS and Ctrl elsewhere. `Shift+` is implied by uppercase letters, and `?` is matched by `e.key`.
- Scopes form a stack, and resolution walks from the top. Modal scopes (palette, help, composer) are **exclusive**: lower scopes don't fire, except bindings flagged `global: true` (`$mod+k`, `Escape`).
- When the target is editable (`input`, `textarea`, `[contenteditable]`), only bindings with modifiers and `Escape` fire.
- A chord buffer has a 1000 ms timeout. A "g …" hint shows in the corner while it is pending.
- `HelpOverlay` and `CommandPalette` both read `keymap.all()`.
- `bindings.ts` registers the defaults below.

**Default bindings**

| Keys                                  | Action                                              |
| ------------------------------------- | --------------------------------------------------- |
| `j` / `↓`, `k` / `↑`                  | next / previous item                                |
| `J` / `K`                             | extend selection                                    |
| `x`                                   | toggle select                                       |
| `Enter` / `o`                         | focus thread pane                                   |
| `Esc`                                 | back to list, clear selection, close modal          |
| `e`, `d`                              | mark done (selection or current)                    |
| `m`                                   | mark replied without replying                       |
| `u`                                   | move back to inbox                                  |
| `z` / `$mod+z`                        | undo last action                                    |
| `r`                                   | reply: open composer focused, restore draft         |
| `$mod+Enter` (composer)               | send (Phase 1: copy, open on YouTube, mark replied) |
| `$mod+Shift+c` (composer)             | copy only                                           |
| `v`                                   | open comment on YouTube                             |
| `V`                                   | open video                                          |
| `s`                                   | sync now                                            |
| `S`                                   | deep sync current video                             |
| `/`                                   | focus search                                        |
| `.`                                   | show new items                                      |
| `g i` / `g d` / `g a` / `g s` / `g ,` | Inbox / Done / All / Sources / Settings             |
| `g v`                                 | filter inbox to the current video                   |
| `g c`                                 | clear filters                                       |
| `$mod+k`                              | command palette                                     |
| `?`                                   | help                                                |
| `t`                                   | cycle theme                                         |

**Command palette**

- Fuzzy matching is a simple in-house subsequence scorer.
- Entries: all palette-enabled bindings (with their shortcut shown), dynamic "Go to source: …" and "Filter by video: …" entries, and "Add source…".
- Executing an entry runs its binding.

**Layout** (`Shell.svelte`)

- A left sidebar of 220 px, collapsible with `[`. It holds the views (Inbox count badge, Done, All), a sources list with per-source inbox counts, and a footer with the sync indicator and quota meter.
- The center list is 380–440 px, resizable.
- The right thread pane fills the rest.
- Below 900 px it becomes a single pane: the list, then the thread on Enter with Esc to go back.
- **InboxRow**, at a fixed 72 px:
  - avatar (24 px);
  - author, a relative time, and a "↳ reply to X" marker when it has a parent;
  - a 2-line clamp of `textPlain`;
  - the video title truncated in muted text;
  - a draft dot.
  - The selected row gets an accent left-border and tinted background. Multi-selected rows get a checkbox tint.
- **VirtualList.svelte**, custom with fixed row height:
  - renders only visible rows plus 10 overscan;
  - keeps the selected index scrolled into view with `block: nearest`;
  - calls `loadMore` 20 rows from the end.
- **ThreadView**:
  - a video header with thumbnail, title, and a link to the video;
  - the top-level comment, then the replies;
  - the focused comment highlighted and scrolled into view;
  - own comments with an "You" badge and accent-tinted background;
  - "N more replies not fetched" when `total > fetched`;
  - the composer pinned at the bottom.
- **Composer**:
  - an autosizing textarea that prefills `@AuthorName ` when replying to a reply;
  - a char count, and a hint line "⌘↵ copy & open on YouTube · Esc cancel";
  - text that changes with `capabilities` ("⌘↵ Reply" in Phase 2).
- **Rendering comment HTML**: `sanitize.ts` runs DOMPurify with tags `a, br, b, i, s, span` and attribute `href`, forces `target=_blank rel=noopener noreferrer`, and is the only place `{@html}` is used.

**Sources view**

- An "Add source" input that previews the parsed input live (kind and id), with an own-channel toggle and a "Import existing: none / last N days / all" segmented control.
- A table of sources showing kind icon, title, video count, inbox count, last sync, error, enabled toggle, and projected units/day.
- Drilling into a source shows its videos with tier, last synced, comments-disabled badge, a tier-override dropdown, and per-video "sync now".

**Settings view**

- API key: a masked field with its source label and a test button. A notice explains that an env or file key takes priority, depending on resolution order.
- Own channel ids: a chip list with add/remove, validated with a regex for `UC[\w-]{22}`.
- Poll on/off, daily budget, manual reserve, backfill days, theme.
- A read-only quota ledger table for today.
- A Demo-mode banner when `settings.demo` is true.

**Empty states**

- No API key: a full-page onboarding with a "Set key" form and a pointer to `~/.youtubey-key`.
- No sources: "Add a playlist, video or channel" with the input inline.
- Inbox zero: a calm illustration-free "All caught up" with the last sync time and `s` hint.
- Comments disabled: a badge.
- Quota blocked: a banner with the reset time.

**Visual direction**

- Type: Inter Variable at 14 px base, 13 px meta and 12 px uppercase tracking for section labels. JetBrains Mono for ids and `<Kbd>`. Fonts are self-hosted via `@fontsource`, with no CDN.
- Spacing on a 4 px scale (4/8/12/16/24/32). Radius 6 px for controls and 10 px for panels.
- `tokens.css` defines `--bg, --bg-elev, --bg-hover, --bg-selected, --border, --text, --text-muted, --text-faint, --accent, --accent-fg, --danger, --success, --focus-ring`.
- Light: zinc neutrals (`#fafafa` bg, `#ffffff` panels, `#18181b` text).
- Dark: `#0b0b0d` bg, `#141417` panels, `#e4e4e7` text.
- Accent: a single warm red-coral (`#ef4444` dark / `#dc2626` light) used sparingly for the unread dot, selected border and primary button. Muted gray-blue serves as the secondary color.
- Motion: 120 ms ease-out transitions on selection and toasts. Honor `prefers-reduced-motion`.
- Focus rings are always visible for keyboard use. No shadows except a subtle one on modals and toasts.
- Density is close to Linear's, with no card chrome around list rows.

## 7. Testing and demo mode

**Server unit tests** (vitest, `:memory:` DB)

- `repo.test.ts`:
  - migrations apply;
  - upsert idempotency;
  - baseline → `archived`;
  - own author → `own`;
  - auto-clear only affects earlier `inbox` comments in the same thread;
  - triage, then undo restores, and undo refuses when the state changed since;
  - FTS search;
  - cursor pagination stability;
  - counts.
- `client.test.ts`:
  - inject `fetch` (constructor param) with recorded JSON fixtures in `server/youtube/fixtures/` (threads page with replies, replies page, `commentsDisabled` 403, `quotaExceeded` 403, 500-then-200);
  - assert URL params (`key`, `part`, `order`, `maxResults`, `pageToken`, `fields`);
  - assert error mapping, retries, and quota charging.
- `engine.test.ts` with `FakeYouTubeClient`:
  - first sync baseline;
  - incremental stop after a known page, asserting the call count, i.e. quota;
  - more than 5 replies triggers `listReplies` pagination;
  - own reply in the thread auto-clears;
  - comments disabled and backoff;
  - `quotaExceeded` aborts and blocks;
  - merging a manual sync with a running poll.
- `tiers.test.ts` and `quota.test.ts`: Pacific-day rollover, using an injected clock.
- `routes.test.ts`: `buildApp({repo, engine, poster, bus, config})` with `app.inject`:
  - each route's happy path;
  - Host/Origin/header rejection;
  - SSE emits `inbox.changed` after a triage.

**Web tests** (vitest + jsdom, kept few)

- `keymap.test.ts`: chords, timeout, scope exclusivity, editable-target suppression, `$mod`.
- `inbox.svelte.test.ts`: optimistic triage, selection advance, and rollback on a failed fetch.
- `parseSourceInput` table tests in `shared/`.

**Demo / fixture mode**

- `YOUTUBEY_DEMO=1` makes `server/index.ts` construct `FakeYouTubeClient(world)` instead of the real client and skips key checks (`capabilities` unchanged, `settings.demo=true`).
- `server/demo/generate.ts` builds a deterministic world from a seeded PRNG (mulberry32, seed 42):
  - one own channel `UCdemoOwnChannel000000000` with 30 videos, plus 2 playlists and 3 standalone third-party videos;
  - about 1,500 comments, with realistic short and long texts including emoji, links and `<br>`, timestamp links, and some threads of 12+ replies;
  - some threads already answered by the own channel;
  - one video with comments disabled and one missing.
- `seed.ts` adds the sources on first boot of an empty demo DB.
- The fake world is "live": each `listCommentThreads` call advances a virtual clock and may append 0–3 new comments or replies to hot videos, so polling and SSE are visible.
- `YOUTUBEY_DEMO_CLOCK=fixed` disables live growth for deterministic e2e runs.
- `POST /api/demo/tick`, mounted only in demo mode, forces new comments for e2e tests.

**Playwright** (`e2e/`, Chromium; `data-testid`s: `inbox-row`, `thread-view`, `composer`, `toast`, `palette`, `help`, `sidebar-count-inbox`)

- `inbox.spec`: `j j e` removes the row, the toast appears, `z` restores it, and counts update.
- `reply.spec`: `r`, typing, then `$mod+Enter`. Grant `clipboard-read/write` permissions and assert the clipboard content and a popup URL containing `&lc=`; the item moves to Done.
- `chords.spec`: `g s` goes to Sources, `?` opens help, `$mod+k` then "done" plus Enter.
- `sources.spec`: adding a demo playlist URL shows the preview, then the row appears and sync progress shows.
- `live.spec`: `/api/demo/tick` produces a "new" pill, `.` shows the items.
- `theme.spec`: `t` toggles `data-theme`.

**Manual check without a key.** Run `npm run demo` and open http://127.0.0.1:5173. Implementers can also drive it with the Chrome tooling.

## 8. Work breakdown (Step 0 serial, then 5 parallel chunks)

**Step 0: scaffold** (lead, about 1 h, must land before the rest)

- Write `package.json` with all deps installed, every tsconfig, the vite/vitest/playwright/eslint/prettier configs, and `.gitignore`.
- Delete the Python code.
- Write the complete `shared/types.ts`, `shared/api.ts` (section 5) and `shared/youtube-urls.ts` with tests.
- Add stub files that export the interfaces below with `throw new Error('TODO')` bodies, so every chunk compiles against them.
- Confirm `better-sqlite3` installs on Node 24 (prebuild). If it does not, stop and escalate (R4).

**Server-side interfaces** (stubs from step 0; the owners named fill them in)

```ts
// server/db/repo.ts  (owner A)
export function openDb(path: string): Database;            // runs migrations
export class Repo { constructor(db: Database, clock?: () => Date);
  getSettings(): StoredSettings; updateSettings(p: Partial<StoredSettings>): StoredSettings;
  listSources(): SourceDTO[]; addSource(s: NewSource): SourceDTO; updateSource(id, p): SourceDTO; deleteSource(id, purge: boolean): void;
  setSourceVideos(sourceId: number, videoIds: {id: string; position: number}[]): {added: string[]};
  upsertVideos(v: YtVideo[]): void; listVideos(sourceId?: number): VideoDTO[]; setVideoTier(id, t): VideoDTO;
  dueVideos(now: Date, limit: number): VideoSyncRow[]; getVideoSyncRow(id): VideoSyncRow|null; updateVideoSync(id, p: Partial<VideoSyncRow>): void;
  getThreadState(threadId): {totalReplyCount: number; fetchedReplyCount: number}|null;
  upsertThread(videoId: string, t: YtThread, replies: YtComment[]): {newCommentIds: string[]}; // applies state rules + auto-clear, in a transaction
  addReplies(threadId: string, replies: YtComment[]): {newCommentIds: string[]};
  listInbox(q: InboxQuery): {items: InboxItem[]; nextCursor: string|null; total: number};
  getThread(threadId): ThreadDetail|null; getComment(id): CommentDTO|null;
  triage(ids: string[], to: CommentState): TriageResult; undo(actionId: number): TriageResult;
  getDraft/putDraft/deleteDraft; markHandedOff(commentId): TriageResult;
  counts(): Counts; recordQuota(dayPt, endpoint, units): void; quotaUsed(dayPt): number;
  startRun/finishRun; lastRun(): SyncRunSummary|null; recomputeOwnership(ownIds: string[]): void; }
// server/youtube/client.ts (owner B): YouTubeClient (section 4), YtThread/YtComment/YtVideo/YtChannel/YtPlaylist in server/youtube/types.ts, YtError in errors.ts
// server/sync/engine.ts (owner B): createSyncEngine({repo, yt, quota, bus, clock}): SyncEngine; createScheduler(...): {start(), stop()}
// server/sync/sources.ts (owner B): resolveAndAddSource(input, opts, {repo, yt}): Promise<SourceDTO>
// server/events/bus.ts (owner C): class EventBus { emit(e: ServerEvent): void; subscribe(fn): () => void }
// server/reply/poster.ts (owner C): ReplyPoster
```

**Chunk A: Database and domain** (owns `server/db/**`)

- Schema, migrations, `Repo`, FTS triggers, the state rules (baseline, own, auto-clear), triage and undo, inbox queries with cursor, counts.
- `projectedUnitsPerDay` is computed here, importing `tierFor()` from `server/sync/tiers.ts`. B writes that file first as a pure function, `tierFor(publishedAt, override, now) → {tier, intervalMin, deepEveryMin}`, so A copies its signature from the stub.
- Tests: `repo.test.ts`.

**Chunk B: YouTube client, sync and demo world** (owns `server/youtube/**`, `server/sync/**`, `server/demo/**`)

- The real client, error mapping, retries, quota ledger usage via `Repo`, tiers, engine, scheduler, source resolution, the `FakeYouTubeClient` and the world generator, plus the seeding logic.
- Tests use a real in-memory `Repo` once A lands. Until then they use a hand-written fake that matches the stub's types.

**Chunk C: HTTP server** (owns `server/index.ts`, `server/app.ts`, `server/config.ts`, `server/security.ts`, `server/routes/**`, `server/events/**`, `server/reply/**`)

- All routes in section 5, SSE with heartbeat and per-client cleanup, static serving with SPA fallback in production, key resolution, demo wiring (`YOUTUBEY_DEMO`, `/api/demo/tick`), and graceful shutdown that stops the scheduler and closes the DB.
- Tests: `routes.test.ts` with stub repo and engine.

**Chunk D: Frontend foundation** (owns `web/index.html`, `web/src/main.ts`, `App.svelte`, `web/src/lib/**`, `web/src/styles/**`, and components `Shell`, `Sidebar`, `CommandPalette`, `HelpOverlay`, `Toasts`, `Kbd`, `VirtualList`, `SyncIndicator`, `QuotaMeter`, `EmptyState`)

- Tokens, theme, router, typed API client (adds the `X-Youtubey` header and throws `ApiError`), SSE, all stores, keymap, `bindings.ts`, `reply.ts`, `sanitize.ts`.
- Exposes the store APIs above. `VirtualList` props: `{items, rowHeight, selectedIndex, onNearEnd, row: Snippet<[T, number]>}`.

**Chunk E: Frontend views** (owns `web/src/views/**` and components `InboxRow`, `ThreadView`, `CommentCard`, `Composer`)

- Uses D's stores and keymap only through their exported APIs, and registers view-scoped bindings via `keymap.register` in `$effect` with cleanup.
- Until D lands, build against D's stub signatures, which step 0 must define (store classes with fields and methods typed and empty).
- Applies `data-testid`s as listed in section 7.

**Chunk F: E2E, docs and integration** (owns `e2e/**`, `playwright.config.ts`, `README.md`)

- Writes the specs against the contract and `data-testid`s immediately and runs them as the other chunks land.
- Afterwards it owns the final integration pass (`npm run typecheck && npm test && npm run test:e2e && npm run lint`) and the README sections: setup, key, demo, shortcuts table, quota notes.

Ordering and dependencies: step 0, then A–F in parallel. Expected integration points: B needs A's `Repo`, C needs A and B, and E needs D. Every chunk builds on the stubs, so there are no shared-file edits. Any change to `shared/*` goes through the lead.

## 9. Risks and open questions

- **R1, `order=time` semantics.** If threads are ordered by creation rather than latest activity, new replies under old threads are invisible to the incremental stop rule. Mitigations: deep scans per tier, and `allThreadsRelatedToChannelId` for own channels.
  - **Spike first (B, 30 min with the real key):** call it on a video where you know an old thread recently got a reply, and see whether that thread surfaces on page 1.
  - If it does surface, drop the deep-scan frequency to weekly.
- **R2, quota with many third-party videos.** "All new comments" on big third-party videos can produce hundreds of inbox items a day, and a playlist of 200 videos at warm tier costs about 4,800 units/day. Mitigations: tiers, projected units in the UI, and the per-video paused tier.
  - **Open:** should old videos in large playlists default to `frozen`?
- **R3, own channel id.** `UC9-y-6csu5WGm29I7JiwpnA` was the default for `watch-counts`. Confirm it is the user's channel and the identity they reply as, since a brand account vs personal channel may differ. `ownChannelIds` is a list to cover both. In demo mode it is seeded. In real mode it is pre-filled with this id with a confirmation prompt in onboarding.
- **R4, better-sqlite3 native build on Node 24.18.** It is likely prebuilt; if not it needs python3 and a C++ toolchain. Do not switch silently to `node:sqlite`; ask the user.
- **R5, `textOriginal` availability.** The API docs say it is only guaranteed to be returned to the comment's author. Use `textFormat=html` and derive `text_plain` server-side by stripping tags and decoding entities, so we never depend on `textOriginal`.
- **R6, clipboard and popup user-gesture rules.** These are handled by doing both synchronously in the handler. Firefox may still block the popup; if so, fall back to a toast with an "Open" link.
- **R7, deleted or edited comments.** Incremental sync does not detect deletions. Deep scans update edited text via `updatedAt`, but deletions are left in place in v1. **Open:** is that acceptable?
- **R8, held-for-review and spam comments.** These are invisible with an API key, since `moderationStatus` needs OAuth. Document this and revisit in Phase 2.
- **R9, Phase 2 OAuth posting.** It needs a Google Cloud OAuth client, localhost redirect, and token storage in the DB. Posting costs 50 units per `comments.insert`. The seam is already in place.
- **Open questions:**
  - Should "replied" via hand-off require the user to confirm after posting on YouTube? Currently it is marked immediately and can be undone with `z`, and auto-clear confirms it on the next sync.
  - Should Shorts be included when tracking a channel's uploads? Yes by default, since the uploads playlist includes them.
  - Should replies under someone else's thread on a third-party video land in the inbox even when the user never participated? The stated rule says all new comments, so yes. A future "only threads I'm in" per-source filter would be cheap to add to `listInbox`.

Sources:

- [youtube-comment-suite](https://awesome.ecosyste.ms/projects/github.com%2Fmattwright324%2Fyoutube-comment-suite)
- [mint-youtube](https://awesome.ecosyste.ms/projects/github.com%2Fumitkaanusta%2Fmint-youtube)
- [youtube-comment-manager topic](https://github.com/topics/youtube-comment-manager)
- [YouTube comments implementation guide](https://developers.google.com/youtube/v3/guides/implementation/comments)
- [commentThreads.list reference](https://developers.google.com/youtube/v3/docs/commentThreads/list)
- [tinykeys README](https://cdn.jsdelivr.net/npm/tinykeys@3.0.0/README.md)
- [Svelte Command Palette shortcuts](https://svelte-command-palette.vercel.app/docs/shortcuts)

### Critical Files for Implementation

- /home/matthew/dev/youtubey/shared/types.ts (and /home/matthew/dev/youtubey/shared/api.ts)
- /home/matthew/dev/youtubey/server/db/repo.ts (with /home/matthew/dev/youtubey/server/db/migrations/001_init.sql)
- /home/matthew/dev/youtubey/server/sync/engine.ts (with /home/matthew/dev/youtubey/server/youtube/client.ts and /home/matthew/dev/youtubey/server/youtube/fake.ts)
- /home/matthew/dev/youtubey/web/src/lib/keys/keymap.svelte.ts
- /home/matthew/dev/youtubey/web/src/lib/stores/inbox.svelte.ts
- Reference for the code being retired: /home/matthew/dev/youtubey/youtubey/main.py
