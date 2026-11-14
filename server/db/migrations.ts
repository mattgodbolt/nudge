// Migrations are embedded as strings (tsc does not copy .sql files). Index + 1 == PRAGMA user_version.
// Append new migrations; never edit an existing one.
export const MIGRATIONS: readonly string[] = [
  /* 001 init */ `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('channel','playlist','video')),
  yt_id TEXT NOT NULL, title TEXT, thumbnail_url TEXT,
  is_own INTEGER NOT NULL DEFAULT 0,
  uploads_playlist_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  import_mode TEXT NOT NULL DEFAULT 'recent' CHECK (import_mode IN ('none','recent','all')),
  added_at TEXT NOT NULL, membership_refreshed_at TEXT, last_error TEXT,
  UNIQUE (kind, yt_id));

CREATE TABLE videos (
  id TEXT PRIMARY KEY, channel_id TEXT, channel_title TEXT, title TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT, published_at TEXT, view_count INTEGER, comment_count INTEGER,
  meta_refreshed_at TEXT,
  comments_disabled INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
  baseline_at TEXT,
  last_synced_at TEXT, next_sync_at TEXT, last_deep_scan_at TEXT,
  error_count INTEGER NOT NULL DEFAULT 0, backoff_until TEXT, last_error TEXT,
  poll_tier TEXT);
CREATE TABLE source_videos (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id), position INTEGER,
  PRIMARY KEY (source_id, video_id));
CREATE INDEX idx_videos_next ON videos(next_sync_at);
CREATE INDEX idx_source_videos_video ON source_videos(video_id);

CREATE TABLE threads (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), channel_id TEXT,
  top_comment_id TEXT NOT NULL, total_reply_count INTEGER NOT NULL DEFAULT 0,
  fetched_reply_count INTEGER NOT NULL DEFAULT 0, can_reply INTEGER NOT NULL DEFAULT 1,
  last_activity_at TEXT NOT NULL, own_last_reply_at TEXT);
CREATE INDEX idx_threads_video ON threads(video_id, last_activity_at DESC);

CREATE TABLE comments (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id TEXT,
  video_id TEXT NOT NULL,
  author_name TEXT NOT NULL, author_channel_id TEXT, author_avatar_url TEXT,
  text_html TEXT NOT NULL, text_plain TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0, published_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  is_own INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('inbox','done','replied','auto_replied','own','archived')),
  state_changed_at TEXT NOT NULL,
  state_source TEXT NOT NULL CHECK (state_source IN ('sync','user','auto')));
CREATE INDEX idx_comments_state ON comments(state, published_at DESC);
CREATE INDEX idx_comments_thread ON comments(thread_id, published_at);
CREATE INDEX idx_comments_video ON comments(video_id, published_at DESC);

-- External-content FTS keyed on comments.rowid. Never VACUUM this database: rowids of
-- tables without an INTEGER PRIMARY KEY may be renumbered, which would desync the index.
CREATE VIRTUAL TABLE comments_fts USING fts5(
  text_plain, author_name, content='comments', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER comments_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, text_plain, author_name) VALUES (new.rowid, new.text_plain, new.author_name);
END;
CREATE TRIGGER comments_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, text_plain, author_name)
    VALUES ('delete', old.rowid, old.text_plain, old.author_name);
END;
CREATE TRIGGER comments_au AFTER UPDATE OF text_plain, author_name ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, text_plain, author_name)
    VALUES ('delete', old.rowid, old.text_plain, old.author_name);
  INSERT INTO comments_fts(rowid, text_plain, author_name) VALUES (new.rowid, new.text_plain, new.author_name);
END;

CREATE TABLE triage_actions (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, to_state TEXT NOT NULL,
  changes TEXT NOT NULL,
  undone_at TEXT);

CREATE TABLE drafts (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','handed_off','posted')));

CREATE TABLE quota_ledger (
  day_pt TEXT NOT NULL, endpoint TEXT NOT NULL, units INTEGER NOT NULL, calls INTEGER NOT NULL,
  PRIMARY KEY (day_pt, endpoint));
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, scope TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, units INTEGER DEFAULT 0, videos INTEGER DEFAULT 0,
  new_comments INTEGER DEFAULT 0, error TEXT);
`,
  /* 002 resumable incremental scans + reply fetch bookkeeping */ `
-- scan_incomplete: a comment scan started but has not reached its legitimate stop; the next scan must not
-- stop at the first all-known page. Videos never synced are treated as incomplete by the engine anyway.
ALTER TABLE videos ADD COLUMN scan_incomplete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN feed_scan_incomplete INTEGER NOT NULL DEFAULT 0;
-- last_reply_fetch_at: when all reply pages of a thread were last fetched OK; reset when total_reply_count changes.
ALTER TABLE threads ADD COLUMN last_reply_fetch_at TEXT;
`,
  /* 003 Google OAuth accounts + reply post log */ `
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
`,
  /* 004 video duration + like count (for the Stats view); NULL until fetched */ `
ALTER TABLE videos ADD COLUMN duration_seconds INTEGER;
ALTER TABLE videos ADD COLUMN like_count INTEGER;
`,
  /* 005 snooze + labels */ `
-- snoozed_until: ISO, in the future while snoozed (the comment stays state='inbox'); woke_at: when the last snooze
-- ended, so woken comments sort back to the top. Plain ADD COLUMN: comments carries the FTS5 external-content index.
ALTER TABLE comments ADD COLUMN snoozed_until TEXT;
ALTER TABLE comments ADD COLUMN woke_at TEXT;
CREATE INDEX idx_comments_snoozed ON comments(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX idx_comments_sort ON comments(state, COALESCE(woke_at, published_at) DESC);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX idx_labels_name ON labels(name COLLATE NOCASE);
CREATE TABLE comment_labels (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, label_id));
CREATE INDEX idx_comment_labels_label ON comment_labels(label_id);
`,
  /* 006 Web Push: one row per subscribed device (browser push endpoint + its encryption keys) */ `
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  new_comments INTEGER NOT NULL DEFAULT 1, snooze_wake INTEGER NOT NULL DEFAULT 1,
  label TEXT, created_at TEXT NOT NULL, last_success_at TEXT, failure_count INTEGER NOT NULL DEFAULT 0);
`,
  /* 007 items: one triage table for every provider (YouTube comments today) */ `
-- items is the shared triage layer: state, snooze, labels, drafts and search live here, keyed by id. A YouTube item's
-- id is its comment id, so links, drafts, undo history and push tags keep working. comments/threads/videos stay as
-- YouTube's detail tables. Other providers (GitHub, ...) add rows here with prefixed ids and their own detail.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  container_key TEXT,
  container_title TEXT,
  title TEXT,
  author TEXT,
  author_avatar_url TEXT,
  is_own INTEGER NOT NULL DEFAULT 0,
  body_plain TEXT NOT NULL DEFAULT '',
  url TEXT,
  occurred_at TEXT NOT NULL,
  available_at TEXT,
  due_at TEXT,
  source_state TEXT,
  reason TEXT,
  data TEXT,
  state TEXT NOT NULL CHECK (state IN ('inbox','done','replied','auto_replied','resolved','own','archived')),
  state_source TEXT NOT NULL CHECK (state_source IN ('sync','user','auto')),
  state_changed_at TEXT NOT NULL,
  snoozed_until TEXT,
  woke_at TEXT,
  first_seen_at TEXT NOT NULL);
CREATE INDEX idx_items_sort ON items(state, COALESCE(woke_at, occurred_at) DESC);
CREATE INDEX idx_items_snoozed ON items(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX idx_items_container ON items(provider, container_key);

INSERT INTO items (id, provider, kind, container_key, container_title, author, author_avatar_url, is_own, body_plain,
                   occurred_at, state, state_source, state_changed_at, snoozed_until, woke_at, first_seen_at)
SELECT c.id, 'youtube', 'comment', c.video_id, v.title, c.author_name, c.author_avatar_url, c.is_own, c.text_plain,
       c.published_at, c.state, c.state_source, c.state_changed_at, c.snoozed_until, c.woke_at, c.first_seen_at
FROM comments c LEFT JOIN videos v ON v.id = c.video_id;

CREATE TABLE item_labels (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, label_id));
CREATE INDEX idx_item_labels_label ON item_labels(label_id);
INSERT INTO item_labels (item_id, label_id) SELECT comment_id, label_id FROM comment_labels;
DROP TABLE comment_labels;

CREATE TABLE drafts_new (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  body TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','handed_off','posted')));
INSERT INTO drafts_new (item_id, body, updated_at, status) SELECT comment_id, body, updated_at, status FROM drafts;
DROP TABLE drafts;
ALTER TABLE drafts_new RENAME TO drafts;

-- The old comment-level search index is replaced by one over items. Nothing references comments now, so it can be
-- rebuilt without the state columns: any code still reading comments.state fails loudly instead of reading stale data.
DROP TRIGGER comments_ai;
DROP TRIGGER comments_ad;
DROP TRIGGER comments_au;
DROP TABLE comments_fts;

CREATE TABLE comments_new (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id TEXT,
  video_id TEXT NOT NULL,
  author_name TEXT NOT NULL, author_channel_id TEXT, author_avatar_url TEXT,
  text_html TEXT NOT NULL, text_plain TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0, published_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  is_own INTEGER NOT NULL DEFAULT 0);
INSERT INTO comments_new (id, thread_id, parent_id, video_id, author_name, author_channel_id, author_avatar_url,
    text_html, text_plain, like_count, published_at, updated_at, first_seen_at, is_own)
  SELECT id, thread_id, parent_id, video_id, author_name, author_channel_id, author_avatar_url,
    text_html, text_plain, like_count, published_at, updated_at, first_seen_at, is_own FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX idx_comments_thread ON comments(thread_id, published_at);
CREATE INDEX idx_comments_video ON comments(video_id, published_at DESC);

-- Deleting a YouTube comment (purge, a deleted reply, a thread cascade) deletes its item.
CREATE TRIGGER comments_item_ad AFTER DELETE ON comments BEGIN
  DELETE FROM items WHERE id = old.id;
END;

-- External-content FTS keyed on items.rowid. Never VACUUM this database: rowids of tables without an INTEGER
-- PRIMARY KEY may be renumbered, which would desync the index.
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, body_plain, author, content='items', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body_plain, author) VALUES (new.rowid, new.title, new.body_plain, new.author);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body_plain, author)
    VALUES ('delete', old.rowid, old.title, old.body_plain, old.author);
END;
CREATE TRIGGER items_au AFTER UPDATE OF title, body_plain, author ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body_plain, author)
    VALUES ('delete', old.rowid, old.title, old.body_plain, old.author);
  INSERT INTO items_fts(rowid, title, body_plain, author) VALUES (new.rowid, new.title, new.body_plain, new.author);
END;
INSERT INTO items_fts(items_fts) VALUES ('rebuild');
`,
  /* 008 feeds (GitHub) and mute rules */ `
-- A feed is one non-YouTube subscription: today, every pull request and issue in a GitHub user's or organisation's
-- repositories. Its items live in the shared items table (provider 'github', feed_id set), so triage, snooze, labels
-- and search all work on them unchanged. Credentials and "who am I" live in the settings table, not here.
CREATE TABLE feeds (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  kind TEXT NOT NULL DEFAULT 'owner',
  owner TEXT NOT NULL,
  owner_type TEXT CHECK (owner_type IN ('org','user')),
  prs INTEGER NOT NULL DEFAULT 1,
  issues INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  import_mode TEXT NOT NULL DEFAULT 'none' CHECK (import_mode IN ('none','recent','all')),
  added_at TEXT NOT NULL,
  baseline_at TEXT,
  cursor TEXT,
  last_polled_at TEXT, next_poll_at TEXT,
  error_count INTEGER NOT NULL DEFAULT 0, backoff_until TEXT, last_error TEXT,
  rate_limit INTEGER, rate_remaining INTEGER, rate_reset_at TEXT,
  UNIQUE (provider, owner));
ALTER TABLE items ADD COLUMN feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE;
ALTER TABLE items ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_items_feed ON items(feed_id);

-- Mute rules apply to items as they arrive (they land archived, still searchable) and never reopen on activity.
CREATE TABLE mute_rules (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('repo','author','bots','item')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, value));
`,
  /* 009 item_events: append-only history of what happens to items (training and evaluation data) */ `
-- Deliberately no foreign key to items and no cascade: history must survive an item being deleted or re-imported.
-- Additive only: nothing here touches an existing table.
CREATE TABLE item_events (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  source TEXT NOT NULL,
  meta TEXT);
CREATE INDEX idx_item_events_item ON item_events(item_id, at);
CREATE INDEX idx_item_events_at ON item_events(at);

-- Backfill from triage_actions, the only existing record of past decisions. Rows whose JSON is malformed (or not an
-- array) and elements that are not objects with a text commentId are skipped, never an error: this runs against the
-- live database. CASE is used wherever a json function could throw, because AND does not short-circuit in SQLite.
-- Labels are not backfilled: item_labels has no timestamps, so any history would be invented.
INSERT INTO item_events (item_id, at, kind, from_value, to_value, source, meta)
SELECT item_id, at, kind, from_value, to_value, 'user', meta FROM (
  WITH ch AS (
    SELECT a.id AS action_id, a.created_at, a.to_state, a.undone_at,
           CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.commentId') END AS item_id,
           CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.from') END AS f,
           CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.to') END AS t
    FROM triage_actions a,
         json_each(CASE WHEN json_valid(a.changes)
                        THEN CASE WHEN json_type(a.changes) = 'array' THEN a.changes ELSE '[]' END
                        ELSE '[]' END) e
  )
  SELECT created_at AS at, action_id, 0 AS ord, item_id,
         CASE WHEN to_state = 'snoozed' THEN 'snooze' ELSE 'state' END AS kind,
         CASE WHEN typeof(f) IN ('text', 'null') THEN f END AS from_value,
         CASE WHEN to_state = 'snoozed' THEN (CASE WHEN typeof(t) IN ('text', 'null') THEN t END) ELSE to_state END AS to_value,
         json_object('backfilled', json('true'), 'actionId', action_id) AS meta
  FROM ch WHERE typeof(item_id) = 'text' AND item_id != ''
  UNION ALL
  SELECT undone_at, action_id, 1, item_id, 'undo',
         CASE WHEN to_state = 'snoozed' THEN (CASE WHEN typeof(t) IN ('text', 'null') THEN t END) ELSE to_state END,
         CASE WHEN typeof(f) IN ('text', 'null') THEN f END,
         json_object('backfilled', json('true'), 'actionId', action_id,
                     'original', CASE WHEN to_state = 'snoozed' THEN 'snooze' ELSE 'state' END,
                     'approximate', json('true'))
  FROM ch WHERE undone_at IS NOT NULL AND typeof(item_id) = 'text' AND item_id != ''
  ORDER BY at, action_id, ord
);
`,
  /* 010 usage_daily: aggregated feature-use counters (internal analytics; counts only, never content) */ `
-- One row per UTC day per allow-listed key (the allow-list lives in shared/usage.ts). Additive only: nothing here
-- touches an existing table. Safe to delete wholesale: "Reset usage data" does exactly that.
CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, key));
`,
  /* 011 suggestions: one current LLM suggestion per item (advisory; nothing acts on it) */ `
-- state_key fingerprints what the model saw, so a changed thread is classified again and an unchanged one never is.
-- One row per item: a new run replaces it. cost_usd is an estimate from token counts. Rules-only rows (no model call)
-- have model 'rules' and cost 0. Additive only: nothing here touches an existing table; safe to delete wholesale.
CREATE TABLE suggestions (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  state_key TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('needs_reply','needs_action','no_reply_needed','spam')),
  category TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  reason TEXT NOT NULL,
  injection_attempt INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE INDEX idx_suggestions_created ON suggestions(created_at);
`,
  /* 012 thread-aware suggestions, snooze "why", and the owner's notes */ `
-- Suggestions gain whose turn it is, the next step, and the thread excerpt the model saw (with the comment count it was
-- fetched at, so the GitHub call is made once per change). All nullable: older rows keep working and are asked again
-- because the prompt version is part of the state key.
ALTER TABLE suggestions ADD COLUMN turn TEXT;
ALTER TABLE suggestions ADD COLUMN next_step TEXT;
ALTER TABLE suggestions ADD COLUMN thread TEXT;
ALTER TABLE suggestions ADD COLUMN thread_count INTEGER;

-- Why the owner snoozed an item, in his words; shown back when it wakes and given to the suggestion prompt.
ALTER TABLE items ADD COLUMN snooze_why TEXT;

-- Everything the owner tells the assistant about a suggestion, an item or a preference. Deliberately no foreign key
-- to items: a note outlives the item it was about. original_text keeps what was said even after the text is edited.
-- suggestion / last_action / context are JSON snapshots taken when the note was made.
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  text TEXT NOT NULL,
  original_text TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('item','standing')),
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK (source IN ('voice','text')),
  item_id TEXT,
  item_title TEXT,
  suggestion TEXT,
  last_action TEXT,
  context TEXT);
CREATE INDEX idx_notes_item ON notes(item_id);
CREATE INDEX idx_notes_created ON notes(created_at);
`,
  /* 013 mute_rules: allow kind 'owner' (mute a whole organisation or user) */ `
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Nothing references mute_rules, and its rows are kept
-- with their ids (item_events.meta refers to rule ids).
CREATE TABLE mute_rules_new (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('repo','owner','author','bots','item')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, value));
INSERT INTO mute_rules_new (id, kind, value, created_at) SELECT id, kind, value, created_at FROM mute_rules;
DROP TABLE mute_rules;
ALTER TABLE mute_rules_new RENAME TO mute_rules;
`,
  /* 014 done_reason: "no action needed" is a kind of done */ `
-- A dismissal ("nothing for me to do") behaves exactly like done everywhere (same state, leaves the inbox, comes back on
-- new activity), so the state stays 'done' and only this column records why. NULL = done in the ordinary sense, which is
-- also what every row from before this migration means. Only meaningful while state = 'done'; triage sets and clears it.
ALTER TABLE items ADD COLUMN done_reason TEXT CHECK (done_reason IS NULL OR done_reason IN ('no_action'));
`,
  /* 015 drop the user-defined labels feature */ `
-- The owner removed Nudge's own labels (coloured tags on items). Nothing was worth keeping: production had none. The
-- link table goes first because it references labels (ON DELETE CASCADE); dropping a table drops its indexes with it.
-- item_events rows of kind label_add / label_remove stay: they are history, and the kinds remain valid in the type.
-- GitHub's own labels live in the items' JSON data, not here, and are untouched.
DROP TABLE item_labels;
DROP TABLE labels;
`,
];
