# Nudge beyond YouTube: design proposal for multiple sources

Status: historical proposal (2026-11-08). Largely built (items spine, GitHub feeds, mutes, native todos instead of the todo sources proposed here, see #7 and #8). Treat as design background, not current behaviour.

## 0. Summary

- **Generalise by adding an `items` table as the triage spine.** `items` owns everything shared: state, snooze,
  labels, search, sort, notifications. `comments`/`threads`/`videos` stay as YouTube's detail tables. Each YouTube
  item **keeps its comment id as its item id**, so URLs (`/inbox?c=`), drafts, `reply_posts`, `triage_actions` JSON
  and push tags all keep working without an id rewrite. Other providers use prefixed ids (`gh:…`, `gt:…`, `local:…`).
  Non-YouTube subscriptions live in a new `feeds` table. I would not rebuild `sources`, because its `CHECK (kind IN
('channel','playlist','video'))` and the `source_videos` cascade make a rebuild risky for little gain.
- **Build GitHub first.** It is the clearest value, and the API suits a poller: `GET /notifications` with
  `If-Modified-Since` costs no rate limit when nothing has changed (304), and `X-Poll-Interval` sets the polling pace.
  Use one classic PAT with **only the `notifications` scope**: the Notifications API officially accepts only classic
  PATs. Fine-grained read-only PATs, one per owner, are optional and add private-repo detail. Use polling. Neither
  webhooks nor Tailscale Funnel is worth it.
- **Google Keep is not available to a personal account.** The official API is an enterprise/Workspace tool built on
  domain-wide delegation. The unofficial `gkeepapi` needs a master token with full access to the Google account,
  which is a hard no. **Google Tasks** is the viable official option, with a read-only scope, polling and dates only
  (no time of day). A Nudge-native "local nudge" (quick capture plus a due date or snooze) is the cheapest
  high-value TODO source, and it also proves the provider framework without any network code.
- Phases: spikes (small), then the items spine refactor (medium-large, no behaviour change), then feeds framework plus
  local nudges (medium), then GitHub notifications (medium), then GitHub standing queries and CI (small-medium), then
  Google Tasks (medium), then optional write-back.

---

## 1. Where the code is YouTube-shaped today (what has to move)

| Concern                    | Where                                                                                                                                                                                          | Coupling                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Triage state, snooze, wake | `comments.state/state_source/state_changed_at/snoozed_until/woke_at` (migrations 001, 005); `repo.triage/undo/snooze/undoSnooze/wakeSnoozed` (`server/db/repo.ts` ~985–1107)                   | All SQL hits `comments` directly                                                                     |
| Labels                     | `comment_labels(comment_id → comments.id)`; `repo.applyLabels`, `labelsFor`, `counts().byLabel`                                                                                                | FK to comments                                                                                       |
| Inbox list / counts        | `INBOX_SELECT` joins `videos`, `threads`, parent comment; `listInbox`, `counts()` (`bySource` via `source_videos`)                                                                             | Joins YouTube tables unconditionally                                                                 |
| Search                     | `comments_fts` external content on `comments.rowid`                                                                                                                                            | Comment text only                                                                                    |
| State rules                | `upsertComment` (own → archived → inbox precedence), `applyOwnReplies`, `recomputeOwnership`                                                                                                   | YouTube semantics, which is fine to keep                                                             |
| Drafts                     | `drafts.comment_id REFERENCES comments(id)`                                                                                                                                                    | FK to comments                                                                                       |
| DTOs                       | `InboxItem { comment: CommentDTO; video; parent; threadReplyCount; … }`, `TriageResult.changes[].commentId`, `SnoozeResult`, `LabelApplyResult.labels` keyed by comment id (`shared/types.ts`) | `comment` is the item                                                                                |
| API                        | `POST /api/triage {commentIds}`, `/api/snooze {commentIds}`, `/api/labels/apply {commentIds}`, `GET /api/threads/:threadId` (`shared/api.ts`)                                                  | Naming only, apart from threads                                                                      |
| Sync                       | `createSyncEngine` (`server/sync/engine.ts`): one queue, one run at a time, `step()` maps `YtError`; `createScheduler` ticks only if `pollEnabled && hasApiKey() && quota.canPoll()`           | **A GitHub poll would be blocked by YouTube's key and quota, and would queue behind a 25-video run** |
| Quota                      | `quota_ledger`, Pacific-day `createQuotaTracker`                                                                                                                                               | YouTube-only, which is correct                                                                       |
| Push                       | `createPushNotifier` (`server/push/notifier.ts`): `resolve()` uses `repo.getComment` + `getThread().video.title`; groups by `videoId`; prefs `newComments/snoozeWake`                          | Comment-shaped                                                                                       |
| Web                        | `inbox.svelte.ts` (~42 `i.comment.id` refs), `InboxRow`, `ThreadView` (video header, YouTube link), `bindings.ts` (`v`/`V` build YouTube URLs, `g v` filters by video), `reply.ts` hand-off    | Comment-shaped                                                                                       |

Every one of these except the YouTube state rules is "shared triage" logic, and it is the part to generalise.

---

## 2. Generalisation: approaches compared

### A. Generalise `comments` in place

Add `provider`, `title`, `url`, `due_at` … columns to `comments` and give GitHub/Tasks rows synthetic `threads` and
`videos` rows (repo ≈ video, PR ≈ thread).

- Pro: the fewest new tables, and every triage query keeps working.
- Con: `thread_id`/`video_id NOT NULL REFERENCES` forces fake rows. A task has no thread. The `state` CHECK
  constraint can only change by rebuilding a table that carries an external-content FTS index (the migration's own
  comment warns about rowids). Stats, quota projections and `source_videos` counts would start counting fake videos.
  The model gets more confusing every time a provider is added. **Reject.**

### B. Parallel table for non-YouTube items, UNION on read

Leave `comments` alone and add `ext_items` with its own state, snooze and labels. `listInbox` and `counts` `UNION
ALL`; triage, snooze and labels dispatch on the id prefix.

- Pro: zero risk to existing YouTube data, and no migration of existing rows.
- Con: triage, undo, snooze, wake, labels, counts, search and the notifier are each written twice, or end up as UNION
  views with `INSTEAD OF` triggers (clever rather than clean). Every later feature (the LLM triage hook, a bulk
  action) pays the cost twice. Undo across a mixed multi-select spans two tables.

### C. `items` spine, with provider detail tables (**recommended**)

One `items` table holds the shared triage fields and a denormalised "card" (title, author, snippet, container, URL)
for every provider. YouTube's `comments`/`threads`/`videos` remain detail tables, joined only when rendering YouTube
detail. Triage, snooze, labels, counts, search and push operate on `items` alone.

- Pro: one implementation of every shared verb. `InboxRow` and the notifier become provider-agnostic. A new state
  value or column is a new table's CHECK, with no FTS rebuild of `comments`. It is the natural place for the LLM
  agent's classification hook.
- Con: a real migration of live data, and a mechanical rewrite of about 25 SQL statements in `repo.ts` plus the DTO
  rename through the web stores. It is mitigated by the strong existing tests (`repo.test.ts`, `snooze-labels.test.ts`,
  `inbox.svelte.test.ts`) and by a counts-invariance check against a copy of the production DB.

### Recommended schema (migration 007)

```sql
-- Non-YouTube subscriptions. YouTube keeps `sources`.
CREATE TABLE feeds (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,            -- 'github' | 'gtasks' | 'local' | …
  kind TEXT NOT NULL,                -- 'gh_notifications' | 'gh_query' | 'gtasks_list' | 'local'
  title TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}', -- JSON: search query, reason filter, repo allow/deny, tasklist id
  credential TEXT,                   -- settings key holding the token (e.g. 'github.token'); never sent to the browser
  enabled INTEGER NOT NULL DEFAULT 1,
  import_mode TEXT NOT NULL DEFAULT 'recent',
  added_at TEXT NOT NULL,
  cursor TEXT, etag TEXT,            -- Last-Modified / updatedMin / ETag, provider-defined
  min_interval_s INTEGER,            -- e.g. GitHub X-Poll-Interval
  next_poll_at TEXT, last_polled_at TEXT,
  error_count INTEGER NOT NULL DEFAULT 0, backoff_until TEXT, last_error TEXT);

CREATE TABLE items (
  id TEXT PRIMARY KEY,               -- YouTube: the comment id, unchanged; others '<prefix>:<native id>'
  provider TEXT NOT NULL,            -- 'youtube' | 'github' | 'gtasks' | 'local'
  kind TEXT NOT NULL,                -- 'comment' | 'pr' | 'issue' | 'discussion' | 'release' | 'ci' | 'task' | 'nudge'
  feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,  -- NULL for youtube (membership via source_videos)
  container_key TEXT,                -- video id / 'owner/repo' / tasklist id: grouping, `V`, notifications
  container_title TEXT,
  title TEXT,                        -- PR/issue/task title; NULL for YouTube comments
  author TEXT, author_avatar_url TEXT,
  is_own INTEGER NOT NULL DEFAULT 0,
  body_plain TEXT NOT NULL DEFAULT '',-- snippet + search text (YouTube: text_plain)
  url TEXT,                          -- "open in source"
  occurred_at TEXT NOT NULL,         -- creation / latest relevant activity; sort key
  available_at TEXT,                 -- provider-set "not before" (a task's due date); distinct from a user snooze
  due_at TEXT,
  source_state TEXT,                 -- provider's own state: 'open' | 'closed' | 'merged' | 'completed' | …
  reason TEXT,                       -- why it needs attention: 'new_comment' | 'review_requested' | 'mention' | 'ci_failed' | 'stale' | 'due' …
  data TEXT,                         -- small provider JSON (PR number, draft flag, check rollup …)
  state TEXT NOT NULL CHECK (state IN ('inbox','done','replied','auto_replied','resolved','own','archived')),
  state_source TEXT NOT NULL CHECK (state_source IN ('sync','user','auto')),
  state_changed_at TEXT NOT NULL,
  snoozed_until TEXT, woke_at TEXT,
  first_seen_at TEXT NOT NULL);
CREATE INDEX idx_items_sort ON items(state, COALESCE(woke_at, occurred_at) DESC);
CREATE INDEX idx_items_snoozed ON items(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX idx_items_available ON items(available_at) WHERE available_at IS NOT NULL;
CREATE INDEX idx_items_feed ON items(feed_id);
CREATE INDEX idx_items_container ON items(provider, container_key);

-- Backfill YouTube: one item per comment, same id, state copied verbatim.
INSERT INTO items (id, provider, kind, container_key, container_title, author, author_avatar_url, is_own, body_plain,
                   url, occurred_at, state, state_source, state_changed_at, snoozed_until, woke_at, first_seen_at)
SELECT c.id, 'youtube', 'comment', c.video_id, v.title, c.author_name, c.author_avatar_url, c.is_own, c.text_plain,
       NULL /* permalink computed in code, as today */, c.published_at, c.state, c.state_source, c.state_changed_at,
       c.snoozed_until, c.woke_at, c.first_seen_at
FROM comments c JOIN videos v ON v.id = c.video_id;

CREATE TABLE item_labels (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                          label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
                          PRIMARY KEY (item_id, label_id));
INSERT INTO item_labels SELECT comment_id, label_id FROM comment_labels;
DROP TABLE comment_labels;
-- drafts: rebuild with FK to items(id) (copy, drop, rename; nothing references drafts, so it is safe with FKs on).

-- Deleting a YouTube comment (purge, removeLocalComment, thread cascade) deletes its item.
CREATE TRIGGER comments_item_ad AFTER DELETE ON comments BEGIN DELETE FROM items WHERE id = old.id; END;

-- One search index over items (title, body, author, container), rebuilt from the backfill.
CREATE VIRTUAL TABLE items_fts USING fts5(title, body_plain, author, container_title,
  content='items', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
-- + ai/ad/au triggers mirroring comments_*; then INSERT INTO items_fts(items_fts) VALUES ('rebuild');
```

Then, in migration 008 (a later release, once 007 has run in production for a while): drop `comments_fts` and its
triggers, the now-unused state, snooze and woke columns on `comments`, and `idx_comments_state` / `idx_comments_sort`
/ `idx_comments_snoozed`. Keeping them for one release costs nothing, and dropping them later avoids a "two sources
of truth" trap only if nothing reads them, so make 007's code stop reading them immediately.

Notes:

- `video.title` is denormalised into `items.container_title`. `upsertVideos` must update it (`UPDATE items SET
container_title=? WHERE provider='youtube' AND container_key=?`).
- The new state `resolved` means "closed or completed at the source". The Done view becomes `IN
('done','replied','auto_replied','resolved')`. The row badge reads "Closed on GitHub" or "Completed in Tasks", as
  `auto_replied` reads "Answered" today.
- The YouTube rules (`upsertComment` precedence, `applyOwnReplies`, `recomputeOwnership`) keep their logic but write
  `items.state` (`UPDATE items SET state='auto_replied' … WHERE id IN (SELECT id FROM comments WHERE thread_id=? AND
published_at < ?)`). They remain YouTube-specific code, which is correct.

### Migration safety

1. `deploy/update.sh` already takes a backup before building (line 20). The risk is the **rollback path**: the
   previous image opens a DB at `user_version` 7. `migrate()` (`server/db/db.ts`) silently does nothing when
   `current > MIGRATIONS.length`, and the old code then reads stale `comments.state`. Before shipping 007, add a
   guard that refuses to start when `user_version > MIGRATIONS.length`, and make `update.sh` restore the pre-update
   snapshot when it rolls back across a schema change.
2. Add a test that builds a 006 DB with the demo world, records `counts()`, `listInbox` for every view, label and
   source, and snooze state, migrates, and asserts the same results. Then run the same script once against a copy of
   the newest NAS backup by hand before merging.
3. Keep `triage_actions.changes` JSON readable: the old rows use `commentId`, so make `undo` accept `commentId ??
itemId`. They are only undoable for 24 h anyway.

### Shared versus per-provider

| Shared (on `items`, provider-agnostic code)                          | Per-provider (`server/providers/<p>/`)                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| state machine, triage, undo, snooze, wake, `available_at` → due wake | fetching, cursors, conditional requests, rate-limit bookkeeping                  |
| labels, label folders, counts, sidebar badges                        | identity ("is this me?": `ownChannelIds` ↔ GitHub login ↔ n/a for tasks)         |
| FTS search, cursor pagination, multi-select                          | mapping native objects to `ItemUpsert` (title, reason, source_state, url)        |
| push notifier: coalesce, age cutoff, grouping by container           | the detail pane (`ThreadView` for YouTube, a PR/issue timeline, a task card)     |
| SSE `inbox.changed`                                                  | available actions and write-back (reply, approve, complete, mark-done-at-source) |
| draft storage (keyed by item id)                                     | deep links (`v` item URL, `V` container URL)                                     |

### Provider seam (server)

```ts
// server/providers/types.ts
export interface ItemUpsert {
  nativeId: string;
  kind: ItemKind;
  title: string | null;
  author: string | null;
  authorAvatarUrl?: string | null;
  isOwn: boolean;
  bodyPlain: string;
  url: string;
  occurredAt: string;
  /** latest activity not by me */ activityAt: string;
  availableAt?: string | null;
  dueAt?: string | null;
  sourceState: string | null;
  reason: string | null;
  container: { key: string; title: string; url?: string };
  data?: Record<string, unknown>;
}
export interface PollResult {
  upserts: ItemUpsert[];
  /** Query feeds only: the complete current result set, so anything missing can be resolved. */
  complete?: boolean;
  cursor?: string | null;
  etag?: string | null;
  minIntervalS?: number;
  rate?: { remaining: number; resetAt: string };
}
export interface Provider {
  id: 'github' | 'gtasks' | 'local';
  poll(feed: FeedRow, signal: AbortSignal): Promise<PollResult>;
  detail?(item: ItemRow): Promise<ItemDetail>; // fetched live on selection, cached; not mirrored in the DB
  actions(item: ItemRow): ItemAction[]; // drives buttons and key `when` predicates
  act?(item: ItemRow, a: ItemAction, body?: string): Promise<ActResult>; // write-back, later phases
}
```

`repo.upsertItems(feedId, ups, {complete})` holds the generic rules (section 4): insert as `inbox` or `archived` by
import mode; reopen on new activity; `resolved` on a closed or completed `source_state`; resolve items that are
missing from a complete query result; never overwrite a user-set state except through the reopen rule.

### Sync and scheduler

- Keep `createSyncEngine` as the YouTube engine, unchanged apart from writing `items`.
- Add `server/sync/feeds.ts`: a `FeedPoller` with **its own queue**. Each feed polls when `next_poll_at <= now`,
  honouring `min_interval_s`, `backoff_until`, and the provider's rate limit. Polls run concurrently across providers
  and one at a time per feed.
- `createScheduler` currently returns early on `!hasApiKey() || !quota.canPoll()`. Split it into two independent
  gates: the YouTube path as today, and `feedPoller.tick()` gated only by `pollEnabled` and each feed's own state.
- `sync_runs`: add `provider TEXT NOT NULL DEFAULT 'youtube'` and `feed_id`. `SyncStatus` stays the YouTube status.
  `FeedDTO` carries `lastPolledAt / nextPollAt / lastError / rate`. `Shift+N` syncs everything; `S` on a GitHub item
  re-polls its feed.
- Quota: YouTube's ledger and `QuotaMeter` stay as they are. GitHub's rate limit is read from the `X-RateLimit-*`
  headers into the feed row and shown on the Sources screen. Google Tasks has a per-project daily quota (default
  quota not verified; expect it to be large).

### API and DTOs

- `InboxItem` becomes `{ item: ItemDTO; labels; snoozedUntil; wokeAt; hasDraft; youtube?: { comment, video, parent,
threadReplyCount } }`, where `ItemDTO = { id, provider, kind, title, author, authorAvatarUrl, isOwn, bodyPlain, url,
occurredAt, dueAt, sourceState, reason, container: {key,title,url}, state, stateSource, actions }`.
- Rename `commentIds` to `ids` in triage, snooze and labels/apply, and `TriageResult.changes[].commentId` to `id`.
  Backward compatibility for old clients is unnecessary: one user, deployed with the server, and a backgrounded tab
  reloads on a version change (`web/src/lib/resync.svelte.ts`). Accepting `commentIds` as an alias for one release
  costs one line, so do it.
- New: `GET /api/items/:id/detail` (provider detail, live), `GET/POST/PATCH/DELETE /api/feeds`, `POST
/api/feeds/:id/poll`, `POST /api/settings/test-github`. `GET /api/threads/:threadId` stays for YouTube.
- `InboxQuery` adds `provider?` and `feedId?`. `Counts` adds `byFeed: Record<number, number>` and `byProvider`.

### UI

- **Sidebar** (`Sidebar.svelte`): the sources list becomes grouped sections, "YouTube" (current sources),
  "GitHub" (feeds) and "Tasks", each header clickable as a provider filter (`/inbox?provider=github`). Label folders
  are unchanged.
- **InboxRow**: renders from `ItemDTO`. Title (PR/issue/task) or author+snippet (comment). Container line (video
  title / `owner/repo` / list name). A reason chip ("review requested", "CI failed", "due today").
- **Detail pane**: `ThreadView` dispatches on `item.provider`: `YouTubeThread` (today's component), `GitHubDetail`
  (title, state, check rollup, last N timeline comments, rendered from `detail`), `TaskDetail` (notes, due date,
  link back). The composer appears only if `actions` includes `reply`.
- **Keys** (`bindings.ts`): `v` = open `item.url` ("Open on YouTube/GitHub/Tasks"), `V` = open the container,
  `g v` becomes "filter to this container". `r` and `m` get `when: actions.includes(...)`. The help overlay and the
  palette already read the registry, so descriptions can come from the provider.
- **Sources screen**: a "YouTube" tab (unchanged, with projected units) and an "Other feeds" tab (add a GitHub feed:
  notifications or a saved query; add a task list; rate-limit status; last poll; error).
- **Settings**: a "GitHub" card (masked token, `last4`, Test). The Test button calls `GET /user`, shows the login, and
  reads `X-OAuth-Scopes`, warning if the token has more than `notifications` (e.g. `repo`), so the read-only
  preference is checked rather than assumed. A "Google Tasks" connection card.
- **Stats**: stays YouTube-only.

---

## 3. GitHub provider

### Verified API facts (docs.github.com, checked today)

- **Notifications** (`GET /notifications`, `/repos/{o}/{r}/notifications`): parameters `all`, `participating`,
  `since`, `before`, `per_page` ≤ 50. Responses carry `Last-Modified`. Sending `If-Modified-Since` returns **304,
  which "leaves your current rate limit untouched"**. `X-Poll-Interval` gives the minimum number of seconds between
  polls; it can increase under load and must be obeyed. `PATCH /notifications/threads/{id}` marks a thread read and
  `DELETE` marks it **done**.
- **Token support:** the notifications endpoints "**only support authentication using a personal access token
  (classic)**", with the `notifications` or `repo` scope. They do not appear in the fine-grained PAT endpoint list,
  so fine-grained tokens and GitHub App user tokens are out for notifications.
- **Reasons:** `assign, author, comment, ci_activity` ("a GitHub Actions workflow run that you triggered was
  completed"), `manual, mention, review_requested` (including team review requests), `state_change, subscribed`
  (watching the repo), `team_mention, security_alert, approval_requested, invitation, security_advisory_credit,
member_feature_requested, agent_session_finished`.
- **Rate limits:** 5,000 requests per hour per user for PATs, shared with apps acting as the user. Search: 30
  requests per minute authenticated, 1,000 results per query, 100 per page. GraphQL: 5,000 points per hour, at least
  1 per call. Secondary limits: 100 concurrent requests, 900 points per minute per REST endpoint, and content
  creation of 80 per minute and 500 per hour.
- **Fine-grained PATs:** each token is limited to **one resource owner** (one user or org), so it cannot access
  multiple organisations at once. Orgs can require approval ("read public resources until approved") or block
  fine-grained tokens entirely. The Checks API is unsupported. `GET /search/issues` and `GET
/repos/{o}/{r}/commits/{ref}/status` **are** supported. Lifetime is 1–366 days or none (orgs may cap it).
- **Classic PATs:** a classic token has access to every repo in every org you belong to. Orgs can disable classic
  tokens, which gives 403s. GitHub deletes classic tokens unused for a year.
- **Not verified:** whether GraphQL accepts fine-grained PATs (I believe it does, but the pages I read do not say),
  whether 304s count toward secondary limits, and exactly what a `notifications`-only classic token can read about
  a **private** repo's subject (it can certainly list the thread; fetching `subject.url` probably needs `repo`).
  Spike 1 below tests these directly.

### What counts as "needs my attention"

Two feed kinds, because GitHub has two kinds of attention:

1. **Event feed: `gh_notifications`** (the primary feed, one per account). It covers "something happened that
   involves me". Poll `GET /notifications?all=false` with `If-Modified-Since`, at the `X-Poll-Interval` pace
   (typically 60 s). Map each thread to an item keyed by **subject**, `gh:<owner>/<repo>#<n>` for issues and PRs,
   so that the search feed below deduplicates against it. Other subject types (Release, Discussion, CheckSuite)
   use `gh:n:<thread id>`. Default reasons:
   - into the inbox: `review_requested, mention, team_mention, assign, author` (activity on my threads), `comment`,
     `ci_activity`, `security_alert`, `approval_requested`;
   - recorded but archived (search and label folders only, never in the inbox): `subscribed` (watching
     compiler-explorer would otherwise flood the inbox), `state_change` (my own action);
   - per-feed config: a reason allow-list and repo/owner allow/deny lists. This is how "my projects" versus
     "another organisation" works: one token, filtered feeds, or two feeds over the same token with different owner
     filters, each with its own sidebar entry and count.
   - Snippet: fetch `subject.latest_comment_url` (1 request) when it is new and readable. Otherwise the snippet is
     the reason ("Review requested by X"). Done thread to done item: optionally `DELETE` the notification thread
     when you press `e` (this needs only `notifications`; see write-back).
2. **Standing-query feed: `gh_query`** (zero or more). It covers "the world is in a state that needs me", which also
   catches things the notification stream misses or that you have marked read on github.com. Use the search API
   every 5 minutes, or one GraphQL search query per feed. Presets:
   - `is:open is:pr review-requested:@me archived:false`: PRs waiting on my review;
   - `is:open is:pr author:@me archived:false`: my PRs. GraphQL `statusCheckRollup.state` and `reviewDecision` give
     `reason='ci_failed'` when the rollup is FAILURE, `'changes_requested'`, `'approved'` (ready to merge), and
     `'stale'` when `updatedAt` is older than N days (default 14);
   - `is:open assignee:@me`: issues and PRs assigned to me (this also makes a private "todo" repo a TODO source for
     free);
   - free-form queries per org: `org:foo is:open is:pr review:required`.

   These are **complete-result** feeds: an item that drops out of the result set is resolved (`resolved`,
   `state_source='auto'`) unless the user set its state.
   The CI-failure check uses GraphQL (`commits(last:1){nodes{commit{statusCheckRollup{state}}}}`) because the
   Checks REST API is not available to fine-grained tokens. With the classic notifications-only token this works
   only for public repos (spike).

Polling budget: notifications at 60 s is about 60 requests per hour, mostly free 304s. Four query feeds at 5 minutes
use 48 search requests per hour against a limit of 30 per minute. Snippet fetches add a few dozen. That is far under
5,000 per hour.

### Authentication (recommended)

- **Required:** one **classic PAT with only the `notifications` scope**. It is read-only apart from marking threads
  read or done and managing subscriptions, which suits the "read-only-ish" preference. Store it like the YouTube key:
  `settings` key `github.token`, also readable from `NUDGE_GITHUB_TOKEN` or `~/.nudge-github-token` (mirroring
  `config.ts` key resolution). Expose only `{configured, source, last4, login, scopes}`.
- **Optional:** fine-grained read-only PATs (Metadata, Issues, Pull requests and Commit statuses, all read), **one
  per owner** whose private repos you want detail for. This is where "another organisation" may need approval, or
  may block fine-grained tokens altogether. Store them as `github.token.<owner>`. The provider picks the token by the
  repo owner and otherwise falls back to the classic token.
- **Rejected:** OAuth App or GitHub App. The notifications endpoints document classic-PAT-only support, an App adds
  a registration and callback flow that is awkward for a tailnet-only box (the same loopback redirect problem as
  Google), and it buys nothing for a single user.
- If both orgs' repos are public, the single notifications-only classic token is enough for everything except
  write-back.

### Polling, webhooks and Tailscale Funnel

Use polling. Webhooks would need Funnel (a public endpoint) and a separate, HMAC-verified listener, because the app
itself has no password and must not be exposed. Even then, webhooks only exist for repos and orgs you administer
(not for "another organisation"), and **there is no webhook for notifications at all**. 304-based polling at about a
minute is as fresh as YouTube polling already is. Not worth it.

### Replying and approving from Nudge

- **Free now:** reuse the existing hand-off path (`web/src/lib/reply.ts`, `postMode: 'handoff'`). `r`, then type,
  then `⌘↵` copies the text, opens the PR or issue URL, and marks the item replied, with no write scope. The
  `Capabilities` DTO becomes per provider (`capabilities.byProvider.github.postMode`).
- **Posting** a comment needs write access (`POST /repos/{o}/{r}/issues/{n}/comments`): classic `public_repo`/`repo`
  (broad write), or fine-grained Issues/Pull requests write per owner. It is medium effort (a `GitHubPoster` beside
  `ApiPoster`, with the `reply_posts` double-post guard reused) and in tension with the read-only preference.
- **Approving** (`POST …/pulls/{n}/reviews {event:'APPROVE'}`, Pull requests write) without looking at the diff is
  the wrong habit to make easy. Recommendation: **do not build it**. `v` opens the PR "Files changed" view, which
  is where approval belongs.
- Worth doing early: **`e` also marks the GitHub notification thread done** (`DELETE
/notifications/threads/{id}`), which needs only the `notifications` scope. github.com/notifications then agrees
  with Nudge. Make it a per-feed toggle, default on. Undo cannot un-done a thread at GitHub; the next real activity
  reopens it anyway. Say this in the undo toast.

---

## 4. Google Keep and TODO sources

### What is available today

- **Google Keep API (official):** described as an API for "enterprise administrators to manage Google Keep notes".
  Both documented auth paths depend on a Workspace domain (domain-wide delegation, or admin-approved scopes). Google's
  2021 launch post says it is for Workspace customers only and not for personal accounts. Community reports show
  personal accounts failing. Scopes `auth/keep` and `auth/keep.readonly` exist. **Verdict: not usable for a personal
  account.** I found no official page that literally says "personal accounts receive error X"; that wording is
  community-sourced.
- **Unofficial Keep (`gkeepapi`, Python):** uses a private mobile API and needs a **master token** that gives full
  account access (by its own docs it must be stored like a password), obtained through `gpsoauth`. Historically that
  flow broke at intervals (NeedsBrowser, "bad authentication"). It is against the ToS spirit and is Python in a Node
  app. **Verdict: no.** Putting a full-account Google credential on a box that also holds a YouTube token is a bad
  trade for a notes app.
- **Google Tasks API (official, consumer accounts):** `tasklists.list` and `tasks.list` with `updatedMin`,
  `showCompleted`, `showDeleted`, `showHidden`, `dueMin`, and `maxResults` ≤ 100. Scopes `auth/tasks` and
  `auth/tasks.readonly`. Task fields: `status` (needsAction/completed), `completed`, `due` (**"only date information
  is recorded; the time portion … is discarded"**, so no time of day), `notes`, `links`, `webViewLink`, `parent`,
  `updated`, `deleted`, `hidden`, and `assignmentInfo` (tasks assigned from Docs or Chat). There is no push or webhook
  and no recurrence field, so poll with `updatedMin`. **Verdict: viable, read-only, medium effort.** Not verified:
  whether Google classes the Tasks scopes as "sensitive", and whether Keep reminders surface in Tasks (Assistant
  reminders were migrated to Tasks; I believe Keep's own reminders were not).

### Adding a Google scope to the existing OAuth setup

- Console: Data Access, then add `…/auth/tasks.readonly`, then save. The app is already "In production" (README
  step 6), so there is no 7-day refresh-token expiry; in Testing, any non-basic scope expires every 7 days. It stays
  unverified under the personal-use exemption (fewer than 100 users), with the same "Google hasn't verified this app"
  click-through as before.
- **A separate connection, not the YouTube one.** `google_accounts` is keyed by **YouTube `channel_id`**, and
  `server/auth/google.ts` hard-codes `SCOPE = youtube.force-ssl`, rejects grants without it, and resolves a channel
  in the callback. A Brand Account channel's token belongs to the Brand Account, whose Tasks are not your personal
  Tasks. Generalise `google.ts` to take a _purpose_ (`youtube` | `tasks`) with its own scope list and callback
  handling. Store the Tasks token in a new `credentials` table (provider, label, refresh_token, scope,
  needs_reauth …) rather than bending `google_accounts`. Request only `tasks.readonly`, and use
  `include_granted_scopes=true` only if the same account is reused.
- The same loopback constraint as today applies: connect over `ssh -L 4517:127.0.0.1:4517 phoenix`.

### Other TODO sources, ranked by value per effort

| Rank | Source                                                                                                                                           | Effort                                 | Value / notes                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Nudge-native "local" nudges**: quick capture (`c`), optional due or snooze, text and a URL; PWA share-target ("share to Nudge" from the phone) | Small                                  | Covers the "remind me about X" job Keep was doing, with the same verbs and push. Provider id `local`, no network. Also exercises the feeds/items framework first.                                     |
| 2    | **GitHub assigned issues in a private `todo` repo**                                                                                              | Free once the GitHub query feed exists | Real TODOs with labels, due dates via milestones, editable from the phone's GitHub app.                                                                                                               |
| 3    | **Google Tasks**                                                                                                                                 | Medium (mostly OAuth generalisation)   | Only worth it if you actually use Tasks or Gmail's "add to Tasks".                                                                                                                                    |
| 4    | **Markdown / Obsidian file** (`- [ ] … 📅 2026-11-10`, Tasks-plugin syntax)                                                                      | Small                                  | The file must be on phoenix (Syncthing or NAS mount). Read-only parse plus file watch; write-back of `[x]` risks sync conflicts.                                                                      |
| 5    | **Email flags (IMAP)**                                                                                                                           | Medium                                 | High value if you star emails as TODOs. IMAP IDLE with an app password (needs 2-Step Verification) avoids the Gmail API's _restricted_ `gmail.readonly` scope. A full-mailbox credential is the risk. |
| 6    | **Todoist**                                                                                                                                      | Small-medium                           | Best API of the lot (personal token; unified API v1 `/sync` with incremental `sync_token`; due datetimes and recurrence). Only if you use it. Rate limits not verified (sources conflict).            |
| 7    | **Microsoft To Do** (Graph `/me/todo/lists/{id}/tasks`, delta)                                                                                   | Medium                                 | Needs an Entra app registration plus OAuth. From memory, not verified. Only if you use it.                                                                                                            |
| 8    | **Apple Reminders**                                                                                                                              | Large / fragile                        | Upgraded (iOS 13+) Reminders left CalDAV and are not reachable from Linux. It would need a Mac-side bridge (EventKit or Shortcuts). Skip.                                                             |
| —    | **Google Keep**                                                                                                                                  | —                                      | No supported route for personal accounts (see above).                                                                                                                                                 |

**Recommendation:** after GitHub, build **local nudges** first: small, no external risk, and they prove the
framework. Add Google Tasks only once you confirm you would use it. If your TODOs actually live in Keep, the honest
answer is to move the actionable ones to Tasks or to local nudges and leave Keep for notes.

---

## 5. Nudging semantics: how these items differ from comments

|                  | YouTube comment                      | GitHub thread (event feed)                                                                                        | GitHub query item                              | Task / local nudge                                                             |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Unit             | one comment (immutable arrival)      | one issue or PR (activity accumulates)                                                                            | one issue or PR (state-based)                  | one task                                                                       |
| Whose            | someone else's                       | either; often mine (my PR)                                                                                        | either                                         | mine                                                                           |
| Arrives when     | first seen                           | new notification activity                                                                                         | enters the result set                          | created, or reaches `available_at` (due)                                       |
| `done` means     | dismissed                            | dismissed **until new activity**                                                                                  | dismissed until the state changes again        | dismissed, or (with write-back) completed                                      |
| Auto-clear       | `auto_replied` when my reply follows | `resolved` when closed or merged (seen via the notification or detail)                                            | `resolved` when it drops out of the result set | `resolved` when completed or deleted at the source                             |
| Reopen           | never (new comment = new item)       | **yes**: activity by someone else after `state_changed_at` → `inbox`, `state_source='sync'`, `woke_at=activityAt` | yes, if it re-enters                           | yes, if reopened at the source or the due date moves later                     |
| Due / recurrence | no                                   | no                                                                                                                | `stale` is time-derived                        | `due_at`, `available_at`; recurrence = new task (Tasks) or due moves (Todoist) |

Rules this implies, all in `repo.upsertItems`:

1. **The "user state is sacred" rule gets one exception**: genuine new activity reopens a `done`/`resolved` item.
   This is what Gmail and GitHub's own inbox do. YouTube is unaffected because its items are atomic.
2. **`available_at` is separate from snooze.** A task due Friday is not "snoozed by me". The Inbox excludes
   `available_at > now`. A new **Upcoming** view (`g u`) lists those items. The existing waker (`wakeSnoozed`, run by
   `server/sync/snooze.ts`) also emits `reason: 'due'` for items whose `available_at` passed. Tasks have no time of
   day, so a configurable local hour (default 08:00) is applied.
3. **Activity wakes a snooze early for activity-based items** ("snooze until Friday or until someone replies").
   This is the natural "nudge me if nothing happens" verb. Stale-PR detection is the inverse: no activity for N days
   creates attention.
4. **Write-back is opt-in per feed** (GitHub mark-done defaults on, Tasks completion defaults off until the scope is
   upgraded). Undo of a write-back is best effort and the toast says so.
5. **Notifications:** `PushPrefs` becomes `{ newComments, snoozeWake, due, providers: Record<provider, boolean>,
reasons?: string[] }`, stored as a JSON `prefs` column on `push_subscriptions` (with the old columns migrated).
   GitHub defaults: push for `review_requested`, `mention`, `ci_failed` and `assign`, not for plain `comment`. Due
   items push immediately, like wake-ups. In `createPushNotifier`, `resolve()` uses `repo.getItem`, the age cutoff
   uses `occurred_at`/`activityAt`, grouping is by `container_title`, and the single-item title becomes a
   provider-formatted line ("Review requested: owner/repo#123 Title"). A reopened item notifies (`reason:
'reopened'`); an auto-resolved one never does.

---

## 6. Extension points for the LLM-triage work (not designed here)

- Everything a classifier needs is on the `items` row: `provider, kind, author, is_own, title, body_plain,
container_title, reason, source_state, url, data`, plus thread context through `detail()` for YouTube and GitHub.
- A single post-insert hook: `upsertItems` and `upsertThread` both return new ids. Emit them through one internal
  `items.added` bus event _before_ the notifier's 20 s coalescing window closes, so a classifier can auto-done or
  auto-label spam before it is pushed. The notifier's `resolve()` already rechecks `state === 'inbox'` at flush time.
- Auto actions use the existing `state_source='auto'` and go through `triage()` / `applyLabels()`, recording a
  `triage_actions` row (tagged `actor: 'llm'`) so `z` and an audit view work. Store verdicts in their own table
  (`item_classifications(item_id, model, verdict, confidence, at)`), not as new `items` columns.
- Keep `reason` (provider fact) separate from any LLM-assigned priority.

---

## 7. Phased plan

| Phase                               | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Size                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0. Spikes                           | (1) Classic PAT with only `notifications`: list a week of notifications, tally `reason` × repo, try fetching a private `subject.url` and `latest_comment_url`, note `X-Poll-Interval`, and confirm a 304 leaves `X-RateLimit-Remaining` unchanged. (2) Try GraphQL `statusCheckRollup` with that token and with a fine-grained PAT. (3) Check whether the "other org" allows fine-grained or classic PATs. (4) Run migration 007 on a copy of the latest backup and diff counts. | Small                                       |
| 1. Items spine                      | Migration 007, startup guard for newer DBs plus restore-on-rollback in `update.sh`, rewrite of the `repo.ts` triage/snooze/labels/counts/search SQL, `ItemDTO`/`InboxItem` reshape, `commentIds`→`ids` (alias kept), web store and row rename, notifier on `getItem`. **No behaviour change**; demo and e2e must pass unchanged.                                                                                                                                                 | Medium-large (the biggest step; mechanical) |
| 2. Feeds framework + local nudges   | `feeds` table, `Provider` seam, `FeedPoller` with its own queue and gating, scheduler split, `available_at` + Upcoming view + due wake, local provider (`c` quick capture, share-target), Sources "Other feeds" tab, sidebar groups, `resolved` state.                                                                                                                                                                                                                           | Medium                                      |
| 3. GitHub notifications (read-only) | Client with conditional requests, X-Poll-Interval and rate tracking; reason/repo filters; reopen rule; `GitHubDetail` pane; per-provider push prefs; Settings card with scope check; hand-off reply; `e` marks the thread done at GitHub. Fake GitHub client and fixtures for demo and tests, as `server/demo` does for YouTube.                                                                                                                                                 | Medium                                      |
| 4. GitHub standing queries          | Search/GraphQL query feeds, complete-result resolution, CI-failed/changes-requested/stale reasons, optional per-owner fine-grained tokens.                                                                                                                                                                                                                                                                                                                                       | Small-medium                                |
| 5. Google Tasks (if wanted)         | Purpose-generalised `google.ts`, `credentials` table, tasks provider (`updatedMin` polling, completion → resolved, due → available_at).                                                                                                                                                                                                                                                                                                                                          | Medium                                      |
| 6. Optional write-back              | GitHub comment posting (`GitHubPoster`, reply_posts guard), Tasks completion on `e` (`tasks` scope). No approve.                                                                                                                                                                                                                                                                                                                                                                 | Small each                                  |

**Riskiest assumptions, to test first:**

1. That a notifications-only classic token gives useful content for the repos you care about. If private-repo
   subjects are unreadable, items are title-only, and you either accept that, add per-owner fine-grained tokens, or
   accept `repo` scope. (Spike 1)
2. Notification volume and signal: if `participating`-type reasons are still noisy (bots, Dependabot, CI on every
   push), the feed needs author filters (`dependabot[bot]`) on day one. (Spike 1 tally)
3. That the "other organisation" permits the token type you choose. (Spike 3)
4. That migration 007 is count-invariant on real data, and that the rollback story works. (Spike 4)
5. That you actually keep TODOs anywhere reachable. If they live only in Keep, phase 5 is moot.

## 8. Open questions for you

1. Which GitHub orgs and repos, and are any of them private? Does the "other organisation" restrict PAT types?
2. Is a classic `notifications`-only token acceptable, given that it is the only token type the Notifications API
   supports? Would you ever accept `public_repo` to post comments, or is hand-off (copy and open) enough?
3. Should `e` on a GitHub item also mark the notification done on github.com (proposed default: yes)?
4. Should `subscribed` (repos you watch) ever reach the inbox, perhaps for a short allow-list of repos?
5. Should a done GitHub thread reopen on _any_ new activity by someone else, or only on reasons aimed at you
   (mention, review request)?
6. Where do your TODOs actually live: Keep, Tasks, a notes file, starred email? Would Nudge-native quick capture
   replace Keep for the "nudge me" part?
7. Is your YouTube channel a Brand Account? That decides whether a Tasks connection can share the existing Google
   sign-in. The proposal assumes a separate connection either way.
8. Stale-PR threshold (default 14 days), and should drafts be excluded?
9. Push: which GitHub reasons should buzz your phone?

## Sources

- GitHub notifications REST API: https://docs.github.com/en/rest/activity/notifications
- REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Search API: https://docs.github.com/en/rest/search/search
- GraphQL rate limits: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- Fine-grained PAT endpoints: https://docs.github.com/en/rest/authentication/endpoints-available-for-fine-grained-personal-access-tokens
- Fine-grained PAT permissions: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- Managing PATs: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- Google Keep API overview: https://developers.google.com/workspace/keep/api/guides
- Keep API launch (Workspace only): https://workspaceupdates.googleblog.com/2021/05/keep-audit-logs-and-api.html
- gkeepapi docs: https://gkeepapi.readthedocs.io/en/latest/index.html
- Google Tasks API: https://developers.google.com/workspace/tasks/reference/rest , …/v1/tasks , …/v1/tasks/list
- Google OAuth scopes: https://developers.google.com/identity/protocols/oauth2/scopes
- Todoist API v1: https://developer.todoist.com/api/v1/
- iCloud Reminders left CalDAV: https://support.busymac.com/blog/112990
