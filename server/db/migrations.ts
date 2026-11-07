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
];
