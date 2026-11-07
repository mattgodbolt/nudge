/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  CommentDTO,
  CommentState,
  Counts,
  ImportMode,
  InboxItem,
  PollTier,
  SourceDTO,
  SyncRunSummary,
  ThreadDetail,
  TriageResult,
  VideoDTO,
} from '../../shared/types.js';
import type { DraftDTO, InboxPage, InboxQuery } from '../../shared/api.js';
import { permalink } from '../../shared/youtube-urls.js';
import type {
  NewSource,
  Repo,
  SourceRow,
  StoredSettings,
  VideoSyncRow,
  YtComment,
  YtThread,
  YtVideo,
} from '../contracts.js';
import { openDb, type Db } from './db.js';
import { htmlToPlain } from './text.js';
import { tierFor, unitsPerDay } from './tiers-lite.js';

type Row = Record<string, any>;

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
const EPOCH = '1970-01-01T00:00:00.000Z';
const OWN_FEED_UNITS_PER_DAY = 144; // allThreadsRelatedToChannelId every 10 min
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const DEFAULT_SETTINGS: StoredSettings = {
  apiKey: null,
  ownChannelIds: [],
  pollEnabled: true,
  dailyQuotaBudget: 9000,
  manualReserve: 1000,
  backfillDays: 14,
  theme: 'system',
};

export type UndoErrorCode = 'not_found' | 'already_undone' | 'expired';
export class UndoError extends Error {
  constructor(
    public code: UndoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UndoError';
  }
}

/** Normalise any ISO-ish timestamp so string comparison in SQL is chronological. */
function iso(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function commentDto(r: Row): CommentDTO {
  return {
    id: r.id,
    threadId: r.thread_id,
    parentId: r.parent_id,
    videoId: r.video_id,
    authorName: r.author_name,
    authorChannelId: r.author_channel_id,
    authorAvatarUrl: r.author_avatar_url,
    textHtml: r.text_html,
    textPlain: r.text_plain,
    likeCount: r.like_count,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
    isOwn: !!r.is_own,
    state: r.state,
    stateSource: r.state_source,
    permalink: permalink(r.video_id, r.id),
  };
}

/** Turn free text into an FTS5 prefix-AND query; null when there is nothing searchable. */
function ftsQuery(q: string): string | null {
  const tokens = q.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export function createRepo(db: Db, clock: () => Date = () => new Date()): Repo {
  const now = () => clock().toISOString();

  /* ---------------- settings ---------------- */
  function getSettings(): StoredSettings {
    const out: Row = { ...DEFAULT_SETTINGS };
    for (const r of db.prepare('SELECT key, value FROM settings').all() as Row[]) {
      if (r.key in DEFAULT_SETTINGS) {
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {
          /* keep default */
        }
      }
    }
    return out as StoredSettings;
  }
  const putSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const ownIds = () => getSettings().ownChannelIds;

  function updateSettings(p: Partial<StoredSettings>): StoredSettings {
    const before = getSettings();
    db.transaction(() => {
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || !(k in DEFAULT_SETTINGS) || k === 'ownChannelIds') continue;
        putSetting.run(k, JSON.stringify(v));
      }
      if (p.ownChannelIds && JSON.stringify(p.ownChannelIds) !== JSON.stringify(before.ownChannelIds)) {
        recomputeOwnership(p.ownChannelIds);
      }
    })();
    return getSettings();
  }

  /* ---------------- videos ---------------- */
  const VIDEO_SELECT = `SELECT v.*, (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.state = 'inbox') AS inbox_count
    FROM videos v`;

  function videoDto(r: Row, at: Date): VideoDTO {
    return {
      id: r.id,
      title: r.title,
      channelId: r.channel_id,
      channelTitle: r.channel_title,
      thumbnailUrl: r.thumbnail_url,
      publishedAt: r.published_at,
      viewCount: r.view_count,
      commentCount: r.comment_count,
      commentsDisabled: !!r.comments_disabled,
      missing: !!r.missing,
      tier: tierFor(r.published_at, r.poll_tier, at).tier,
      tierOverride: r.poll_tier,
      lastSyncedAt: r.last_synced_at,
      nextSyncAt: r.next_sync_at,
      lastError: r.last_error,
      inboxCount: r.inbox_count ?? 0,
    };
  }

  function syncRow(r: Row, own: string[]): VideoSyncRow {
    return {
      id: r.id,
      channelId: r.channel_id,
      publishedAt: r.published_at,
      commentsDisabled: !!r.comments_disabled,
      missing: !!r.missing,
      baselineAt: r.baseline_at,
      lastSyncedAt: r.last_synced_at,
      nextSyncAt: r.next_sync_at,
      lastDeepScanAt: r.last_deep_scan_at,
      errorCount: r.error_count,
      backoffUntil: r.backoff_until,
      lastError: r.last_error,
      pollTier: r.poll_tier,
      isOwnChannel: r.channel_id != null && own.includes(r.channel_id),
      metaRefreshedAt: r.meta_refreshed_at,
      scanIncomplete: !!r.scan_incomplete,
    };
  }

  function baselineFor(mode: ImportMode): string {
    if (mode === 'all') return EPOCH;
    if (mode === 'none') return now();
    const days = getSettings().backfillDays;
    return new Date(clock().getTime() - days * 86_400_000).toISOString();
  }

  function ensureVideoStub(id: string): void {
    db.prepare('INSERT OR IGNORE INTO videos (id, next_sync_at) VALUES (?, ?)').run(id, now());
  }

  function upsertVideos(vs: YtVideo[]): void {
    const stmt = db.prepare(`INSERT INTO videos
        (id, channel_id, channel_title, title, thumbnail_url, published_at, view_count, comment_count, meta_refreshed_at, next_sync_at)
      VALUES (@id, @channelId, @channelTitle, @title, @thumbnailUrl, @publishedAt, @viewCount, @commentCount, @at, @at)
      ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, channel_title = excluded.channel_title,
        title = excluded.title, thumbnail_url = excluded.thumbnail_url, published_at = excluded.published_at,
        view_count = excluded.view_count, comment_count = excluded.comment_count,
        meta_refreshed_at = excluded.meta_refreshed_at`);
    const at = now();
    db.transaction(() => {
      for (const v of vs) stmt.run({ ...v, publishedAt: v.publishedAt ? iso(v.publishedAt) : null, at });
    })();
  }

  function videoRows(sourceId?: number): Row[] {
    return (
      sourceId === undefined
        ? db.prepare(`${VIDEO_SELECT} ORDER BY v.published_at DESC, v.id`).all()
        : db
            .prepare(
              `${VIDEO_SELECT} JOIN source_videos sv ON sv.video_id = v.id AND sv.source_id = ?
               ORDER BY v.published_at DESC, v.id`,
            )
            .all(sourceId)
    ) as Row[];
  }

  function listVideos(sourceId?: number): VideoDTO[] {
    const at = clock();
    return videoRows(sourceId).map((r) => videoDto(r, at));
  }

  function setVideoTier(id: string, t: PollTier | null): VideoDTO {
    const res = db.prepare('UPDATE videos SET poll_tier = ? WHERE id = ?').run(t, id);
    if (res.changes === 0) throw new Error(`Unknown video ${id}`);
    return videoDto(db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(id) as Row, clock());
  }

  function dueVideos(at: Date, limit: number): VideoSyncRow[] {
    const own = ownIds();
    const iso_ = at.toISOString();
    return (
      db
        .prepare(
          `SELECT v.* FROM videos v
           WHERE (v.next_sync_at IS NULL OR v.next_sync_at <= @now)
             AND (v.backoff_until IS NULL OR v.backoff_until <= @now)
             AND v.missing = 0 AND COALESCE(v.poll_tier, '') != 'paused'
             AND EXISTS (SELECT 1 FROM source_videos sv JOIN sources s ON s.id = sv.source_id
                         WHERE sv.video_id = v.id AND s.enabled = 1)
           ORDER BY v.next_sync_at LIMIT @limit`,
        )
        .all({ now: iso_, limit }) as Row[]
    ).map((r) => syncRow(r, own));
  }

  function allVideoRows(sourceId?: number): VideoSyncRow[] {
    const own = ownIds();
    const rows = (
      sourceId === undefined
        ? db
            .prepare(
              `SELECT v.* FROM videos v WHERE EXISTS (SELECT 1 FROM source_videos sv JOIN sources s ON s.id = sv.source_id
                 WHERE sv.video_id = v.id AND s.enabled = 1)`,
            )
            .all()
        : db
            .prepare('SELECT v.* FROM videos v JOIN source_videos sv ON sv.video_id = v.id AND sv.source_id = ?')
            .all(sourceId)
    ) as Row[];
    return rows.map((r) => syncRow(r, own));
  }

  function getVideoSyncRow(id: string): VideoSyncRow | null {
    const r = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as Row | undefined;
    return r ? syncRow(r, ownIds()) : null;
  }

  const SYNC_COLUMNS: Record<string, { col: string; bool?: boolean }> = {
    channelId: { col: 'channel_id' },
    publishedAt: { col: 'published_at' },
    commentsDisabled: { col: 'comments_disabled', bool: true },
    missing: { col: 'missing', bool: true },
    baselineAt: { col: 'baseline_at' },
    lastSyncedAt: { col: 'last_synced_at' },
    nextSyncAt: { col: 'next_sync_at' },
    lastDeepScanAt: { col: 'last_deep_scan_at' },
    errorCount: { col: 'error_count' },
    backoffUntil: { col: 'backoff_until' },
    lastError: { col: 'last_error' },
    pollTier: { col: 'poll_tier' },
    scanIncomplete: { col: 'scan_incomplete', bool: true },
  };

  function updateVideoSync(id: string, p: Partial<VideoSyncRow>): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(p)) {
      const m = SYNC_COLUMNS[k];
      if (!m || v === undefined) continue;
      sets.push(`${m.col} = ?`);
      args.push(m.bool ? (v ? 1 : 0) : v);
    }
    if (sets.length) db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  /* ---------------- sources ---------------- */
  function sourceRow(r: Row): SourceRow {
    return {
      id: r.id,
      kind: r.kind,
      ytId: r.yt_id,
      title: r.title,
      thumbnailUrl: r.thumbnail_url,
      isOwn: !!r.is_own,
      importMode: r.import_mode,
      uploadsPlaylistId: r.uploads_playlist_id,
      enabled: !!r.enabled,
      membershipRefreshedAt: r.membership_refreshed_at,
      feedScanIncomplete: !!r.feed_scan_incomplete,
    };
  }

  function listSources(): SourceDTO[] {
    const at = clock();
    const sources = db.prepare('SELECT * FROM sources ORDER BY id').all() as Row[];
    const videos = db
      .prepare(
        `SELECT sv.source_id, v.published_at, v.poll_tier, v.comments_disabled, v.missing
         FROM source_videos sv JOIN videos v ON v.id = sv.video_id`,
      )
      .all() as Row[];
    const inbox = new Map<number, number>(
      (
        db
          .prepare(
            `SELECT sv.source_id, COUNT(*) AS n FROM comments c JOIN source_videos sv ON sv.video_id = c.video_id
             WHERE c.state = 'inbox' GROUP BY sv.source_id`,
          )
          .all() as Row[]
      ).map((r) => [r.source_id, r.n]),
    );
    const agg = new Map<number, { count: number; units: number }>();
    for (const v of videos) {
      const a = agg.get(v.source_id) ?? { count: 0, units: 0 };
      a.count++;
      if (!v.comments_disabled && !v.missing) a.units += unitsPerDay(tierFor(v.published_at, v.poll_tier, at));
      agg.set(v.source_id, a);
    }
    return sources.map((s) => {
      const a = agg.get(s.id) ?? { count: 0, units: 0 };
      const feed = s.is_own && s.kind === 'channel' ? OWN_FEED_UNITS_PER_DAY : 0;
      return {
        id: s.id,
        kind: s.kind,
        ytId: s.yt_id,
        title: s.title,
        thumbnailUrl: s.thumbnail_url,
        isOwn: !!s.is_own,
        enabled: !!s.enabled,
        importMode: s.import_mode,
        addedAt: s.added_at,
        videoCount: a.count,
        inboxCount: inbox.get(s.id) ?? 0,
        lastError: s.last_error,
        projectedUnitsPerDay: s.enabled ? Math.round(a.units + feed) : 0,
      };
    });
  }

  function sourceDto(id: number): SourceDTO {
    const s = listSources().find((x) => x.id === id);
    if (!s) throw new Error(`Unknown source ${id}`);
    return s;
  }

  function getSourceRow(id: number): SourceRow | null {
    const r = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Row | undefined;
    return r ? sourceRow(r) : null;
  }

  function addSource(s: NewSource): SourceDTO {
    const existing = db.prepare('SELECT id FROM sources WHERE kind = ? AND yt_id = ?').get(s.kind, s.ytId) as
      Row | undefined;
    if (existing) return sourceDto(existing.id);
    const res = db
      .prepare(
        `INSERT INTO sources (kind, yt_id, title, thumbnail_url, is_own, uploads_playlist_id, import_mode, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.kind, s.ytId, s.title, s.thumbnailUrl, s.isOwn ? 1 : 0, s.uploadsPlaylistId ?? null, s.importMode, now());
    return sourceDto(Number(res.lastInsertRowid));
  }

  function updateSource(
    id: number,
    p: Partial<{
      enabled: boolean;
      isOwn: boolean;
      title: string;
      importMode: ImportMode;
      membershipRefreshedAt: string;
      lastError: string | null;
      feedScanIncomplete: boolean;
    }>,
  ): SourceDTO {
    const map: Record<string, [string, (v: any) => unknown]> = {
      enabled: ['enabled', (v) => (v ? 1 : 0)],
      isOwn: ['is_own', (v) => (v ? 1 : 0)],
      title: ['title', (v) => v],
      importMode: ['import_mode', (v) => v],
      membershipRefreshedAt: ['membership_refreshed_at', (v) => v],
      lastError: ['last_error', (v) => v],
      feedScanIncomplete: ['feed_scan_incomplete', (v) => (v ? 1 : 0)],
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(p)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      args.push(m[1](v));
    }
    if (sets.length) {
      const res = db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      if (res.changes === 0) throw new Error(`Unknown source ${id}`);
    }
    return sourceDto(id);
  }

  function deleteSource(id: number, purge: boolean): void {
    db.transaction(() => {
      const mine = (db.prepare('SELECT video_id FROM source_videos WHERE source_id = ?').all(id) as Row[]).map(
        (r) => r.video_id as string,
      );
      db.prepare('DELETE FROM sources WHERE id = ?').run(id); // cascades source_videos
      if (!purge) return;
      const orphan = db.prepare('SELECT 1 FROM source_videos WHERE video_id = ? LIMIT 1');
      for (const vid of mine) {
        if (orphan.get(vid)) continue;
        db.prepare('DELETE FROM threads WHERE video_id = ?').run(vid); // cascades comments + drafts
        db.prepare('DELETE FROM videos WHERE id = ?').run(vid);
      }
    })();
  }

  function setSourceVideos(sourceId: number, videos: { id: string; position: number }[]): { added: string[] } {
    const src = getSourceRow(sourceId);
    if (!src) throw new Error(`Unknown source ${sourceId}`);
    const added: string[] = [];
    db.transaction(() => {
      const baseline = baselineFor(src.importMode);
      const has = db.prepare('SELECT 1 FROM source_videos WHERE source_id = ? AND video_id = ?');
      const link = db.prepare(
        `INSERT INTO source_videos (source_id, video_id, position) VALUES (?, ?, ?)
         ON CONFLICT(source_id, video_id) DO UPDATE SET position = excluded.position`,
      );
      const setBase = db.prepare('UPDATE videos SET baseline_at = ? WHERE id = ? AND baseline_at IS NULL');
      for (const v of videos) {
        ensureVideoStub(v.id);
        setBase.run(baseline, v.id);
        if (!has.get(sourceId, v.id)) added.push(v.id);
        link.run(sourceId, v.id, v.position);
      }
    })();
    return { added };
  }

  /* ---------------- threads and comments ---------------- */
  function getThreadState(threadId: string) {
    const r = db
      .prepare('SELECT total_reply_count, fetched_reply_count, last_reply_fetch_at FROM threads WHERE id = ?')
      .get(threadId) as Row | undefined;
    return r
      ? {
          totalReplyCount: r.total_reply_count as number,
          fetchedReplyCount: r.fetched_reply_count as number,
          lastReplyFetchAt: r.last_reply_fetch_at as string | null,
        }
      : null;
  }

  function markRepliesFetched(threadId: string): void {
    db.prepare('UPDATE threads SET last_reply_fetch_at = ? WHERE id = ?').run(now(), threadId);
  }

  /** Insert or refresh one comment. Returns 'new' | 'changed' | 'same'. */
  function upsertComment(
    c: YtComment,
    threadId: string,
    parentId: string | null,
    videoId: string,
    ctx: {
      own: string[];
      baseline: string | null;
      at: string;
    },
  ): 'new' | 'changed' | 'same' {
    const published = iso(c.publishedAt);
    const updated = iso(c.updatedAt);
    const existing = db.prepare('SELECT text_html FROM comments WHERE id = ?').get(c.id) as Row | undefined;
    if (existing) {
      const textChanged = existing.text_html !== c.textHtml;
      db.prepare(
        `UPDATE comments SET text_html = ?, text_plain = ?, like_count = ?, updated_at = ?, author_name = ?,
           author_avatar_url = ? WHERE id = ?`,
      ).run(c.textHtml, htmlToPlain(c.textHtml), c.likeCount, updated, c.authorName, c.authorAvatarUrl, c.id);
      return textChanged ? 'changed' : 'same';
    }
    const isOwn = c.authorChannelId != null && ctx.own.includes(c.authorChannelId);
    const state: CommentState = isOwn ? 'own' : ctx.baseline && published < ctx.baseline ? 'archived' : 'inbox';
    db.prepare(
      `INSERT INTO comments (id, thread_id, parent_id, video_id, author_name, author_channel_id, author_avatar_url,
         text_html, text_plain, like_count, published_at, updated_at, first_seen_at, is_own, state, state_changed_at,
         state_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync')`,
    ).run(
      c.id,
      threadId,
      parentId,
      videoId,
      c.authorName,
      c.authorChannelId,
      c.authorAvatarUrl,
      c.textHtml,
      htmlToPlain(c.textHtml),
      c.likeCount,
      published,
      updated,
      ctx.at,
      isOwn ? 1 : 0,
      state,
      ctx.at,
    );
    return 'new';
  }

  /** Auto-clear rule. Returns ids moved to auto_replied. */
  function applyOwnReplies(threadId: string): string[] {
    const r = db
      .prepare('SELECT MAX(published_at) AS m FROM comments WHERE thread_id = ? AND is_own = 1')
      .get(threadId) as Row;
    const lastOwn: string | null = r.m;
    db.prepare('UPDATE threads SET own_last_reply_at = ? WHERE id = ?').run(lastOwn, threadId);
    if (!lastOwn) return [];
    const ids = (
      db
        .prepare(
          `SELECT id FROM comments WHERE thread_id = ? AND state = 'inbox' AND state_source != 'user'
             AND published_at < ?`,
        )
        .all(threadId, lastOwn) as Row[]
    ).map((x) => x.id as string);
    if (ids.length) {
      db.prepare(
        `UPDATE comments SET state = 'auto_replied', state_source = 'auto', state_changed_at = ?
         WHERE thread_id = ? AND state = 'inbox' AND state_source != 'user' AND published_at < ?`,
      ).run(now(), threadId, lastOwn);
    }
    return ids;
  }

  function refreshThreadStats(threadId: string): void {
    db.prepare(
      `UPDATE threads SET
         fetched_reply_count = (SELECT COUNT(*) FROM comments WHERE thread_id = threads.id AND parent_id IS NOT NULL),
         last_activity_at = (SELECT MAX(published_at) FROM comments WHERE thread_id = threads.id)
       WHERE id = ?`,
    ).run(threadId);
  }

  function ctxFor(videoId: string) {
    const v = db.prepare('SELECT baseline_at FROM videos WHERE id = ?').get(videoId) as Row | undefined;
    return { own: ownIds(), baseline: (v?.baseline_at as string | null) ?? null, at: now() };
  }

  function upsertThread(t: YtThread): { newCommentIds: string[]; changedIds: string[] } {
    return db.transaction(() => {
      ensureVideoStub(t.videoId);
      const ctx = ctxFor(t.videoId);
      db.prepare(
        `INSERT INTO threads (id, video_id, channel_id, top_comment_id, total_reply_count, can_reply, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           -- a changed reply total means the earlier complete fetch no longer counts (SET reads the old row)
           last_reply_fetch_at = CASE WHEN total_reply_count != excluded.total_reply_count
                                      THEN NULL ELSE last_reply_fetch_at END,
           total_reply_count = excluded.total_reply_count, can_reply = excluded.can_reply,
           channel_id = excluded.channel_id`,
      ).run(
        t.id,
        t.videoId,
        t.channelId,
        t.topComment.id,
        t.totalReplyCount,
        t.canReply ? 1 : 0,
        iso(t.topComment.publishedAt),
      );
      const newIds: string[] = [];
      const changed: string[] = [];
      const note = (id: string, res: 'new' | 'changed' | 'same') => {
        if (res === 'new') newIds.push(id);
        else if (res === 'changed') changed.push(id);
      };
      note(t.topComment.id, upsertComment(t.topComment, t.id, null, t.videoId, ctx));
      for (const r of t.replies) note(r.id, upsertComment(r, t.id, t.topComment.id, t.videoId, ctx));
      refreshThreadStats(t.id);
      for (const id of applyOwnReplies(t.id)) if (!newIds.includes(id) && !changed.includes(id)) changed.push(id);
      return { newCommentIds: newIds, changedIds: changed };
    })();
  }

  function addReplies(threadId: string, replies: YtComment[]): { newCommentIds: string[]; changedIds: string[] } {
    return db.transaction(() => {
      const th = db.prepare('SELECT video_id, top_comment_id FROM threads WHERE id = ?').get(threadId) as
        Row | undefined;
      if (!th) throw new Error(`Unknown thread ${threadId}`);
      const ctx = ctxFor(th.video_id);
      const newIds: string[] = [];
      const changed: string[] = [];
      for (const r of replies) {
        const res = upsertComment(r, threadId, th.top_comment_id, th.video_id, ctx);
        if (res === 'new') newIds.push(r.id);
        else if (res === 'changed') changed.push(r.id);
      }
      refreshThreadStats(threadId);
      for (const id of applyOwnReplies(threadId)) if (!newIds.includes(id) && !changed.includes(id)) changed.push(id);
      return { newCommentIds: newIds, changedIds: changed };
    })();
  }

  function recomputeOwnership(ids: string[]): void {
    db.transaction(() => {
      const at = now();
      const json = JSON.stringify(ids);
      putSetting.run('ownChannelIds', json);
      db.prepare(
        `UPDATE comments SET is_own = CASE WHEN author_channel_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END`,
      ).run(json);
      db.prepare(
        `UPDATE threads SET own_last_reply_at =
           (SELECT MAX(published_at) FROM comments c WHERE c.thread_id = threads.id AND c.is_own = 1)`,
      ).run();
      const fallback = `CASE WHEN published_at < (SELECT baseline_at FROM videos WHERE id = comments.video_id)
                         THEN 'archived' ELSE 'inbox' END`;
      // Newly-own comments leave whatever (non-user) state they had.
      db.prepare(
        `UPDATE comments SET state = 'own', state_source = 'sync', state_changed_at = ?
         WHERE is_own = 1 AND state != 'own' AND state_source != 'user'`,
      ).run(at);
      // No-longer-own comments go back to inbox/archived.
      db.prepare(
        `UPDATE comments SET state = ${fallback}, state_source = 'sync', state_changed_at = ?
         WHERE is_own = 0 AND state = 'own'`,
      ).run(at);
      // Auto-cleared rows whose justifying own reply has vanished go back.
      db.prepare(
        `UPDATE comments SET state = ${fallback}, state_source = 'sync', state_changed_at = ?
         WHERE state = 'auto_replied' AND state_source = 'auto' AND NOT COALESCE(published_at <
           (SELECT own_last_reply_at FROM threads WHERE id = comments.thread_id), 0)`,
      ).run(at);
      // Re-run auto-clear everywhere.
      db.prepare(
        `UPDATE comments SET state = 'auto_replied', state_source = 'auto', state_changed_at = ?
         WHERE state = 'inbox' AND state_source != 'user' AND published_at <
           (SELECT own_last_reply_at FROM threads WHERE id = comments.thread_id)`,
      ).run(at);
    })();
  }

  /* ---------------- reading ---------------- */
  const INBOX_SELECT = `SELECT c.*, v.title AS v_title, v.thumbnail_url AS v_thumb,
      p.id AS p_id, p.author_name AS p_author, p.text_plain AS p_text, p.is_own AS p_own,
      t.total_reply_count AS t_total,
      EXISTS (SELECT 1 FROM drafts d WHERE d.comment_id = c.id AND d.status = 'draft') AS has_draft
    FROM comments c
    JOIN videos v ON v.id = c.video_id
    JOIN threads t ON t.id = c.thread_id
    LEFT JOIN comments p ON p.id = c.parent_id`;

  function inboxItem(r: Row): InboxItem {
    return {
      comment: commentDto(r),
      video: { id: r.video_id, title: r.v_title, thumbnailUrl: r.v_thumb },
      parent: r.p_id ? { id: r.p_id, authorName: r.p_author, textPlain: r.p_text, isOwn: !!r.p_own } : null,
      threadReplyCount: r.t_total,
      hasDraft: !!r.has_draft,
    };
  }

  function listInbox(q: InboxQuery): InboxPage {
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (q.view === 'inbox') where.push("c.state = 'inbox'");
    else if (q.view === 'done') where.push("c.state IN ('done','replied','auto_replied')");
    else where.push("c.state != 'own'");
    if (q.sourceId !== undefined) {
      where.push('c.video_id IN (SELECT video_id FROM source_videos WHERE source_id = @sourceId)');
      args.sourceId = q.sourceId;
    }
    if (q.videoId) {
      where.push('c.video_id = @videoId');
      args.videoId = q.videoId;
    }
    if (q.q && q.q.trim()) {
      const fts = ftsQuery(q.q);
      if (!fts) return { items: [], nextCursor: null, total: 0 };
      where.push('c.rowid IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH @fts)');
      args.fts = fts;
    }
    const base = where.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM comments c WHERE ${base}`).get(args) as Row).n as number;

    const pageWhere = [base];
    const sep = q.cursor ? q.cursor.indexOf('|') : -1;
    if (q.cursor && sep > 0) {
      args.cPub = q.cursor.slice(0, sep);
      args.cId = q.cursor.slice(sep + 1);
      pageWhere.push('(c.published_at < @cPub OR (c.published_at = @cPub AND c.id > @cId))');
    }
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const rows = db
      .prepare(`${INBOX_SELECT} WHERE ${pageWhere.join(' AND ')} ORDER BY c.published_at DESC, c.id ASC LIMIT @lim`)
      .all({ ...args, lim: limit + 1 }) as Row[];
    const more = rows.length > limit;
    const pageRows = more ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(inboxItem),
      nextCursor: more && last ? `${last.published_at}|${last.id}` : null,
      total,
    };
  }

  function getThread(threadId: string): ThreadDetail | null {
    const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (!t) return null;
    const v = db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(t.video_id) as Row;
    const rows = db
      .prepare(
        `SELECT * FROM comments WHERE thread_id = ?
         ORDER BY (parent_id IS NOT NULL), published_at, id`,
      )
      .all(threadId) as Row[];
    return {
      threadId,
      video: videoDto(v, clock()),
      canReply: !!t.can_reply,
      comments: rows.map(commentDto),
      totalReplyCount: t.total_reply_count,
    };
  }

  function getComment(id: string): CommentDTO | null {
    const r = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Row | undefined;
    return r ? commentDto(r) : null;
  }

  function counts(): Counts {
    const by = new Map<string, number>(
      (db.prepare('SELECT state, COUNT(*) AS n FROM comments GROUP BY state').all() as Row[]).map((r) => [
        r.state,
        r.n,
      ]),
    );
    const n = (s: string) => by.get(s) ?? 0;
    const bySource: Record<number, number> = {};
    for (const s of db.prepare('SELECT id FROM sources').all() as Row[]) bySource[s.id] = 0;
    for (const r of db
      .prepare(
        `SELECT sv.source_id, COUNT(*) AS n FROM comments c JOIN source_videos sv ON sv.video_id = c.video_id
         WHERE c.state = 'inbox' GROUP BY sv.source_id`,
      )
      .all() as Row[]) {
      bySource[r.source_id] = r.n;
    }
    const all = [...by.entries()].reduce((a, [s, c]) => (s === 'own' ? a : a + c), 0);
    return { inbox: n('inbox'), done: n('done') + n('replied') + n('auto_replied'), all, bySource };
  }

  /* ---------------- triage ---------------- */
  function triage(ids: string[], to: CommentState): TriageResult {
    return db.transaction(() => {
      const at = now();
      const get = db.prepare('SELECT state, state_source FROM comments WHERE id = ?');
      const set = db.prepare("UPDATE comments SET state = ?, state_source = 'user', state_changed_at = ? WHERE id = ?");
      const changes: { commentId: string; from: CommentState; to: CommentState }[] = [];
      const stored: { commentId: string; from: CommentState; fromSource: string }[] = [];
      for (const id of new Set(ids)) {
        const r = get.get(id) as Row | undefined;
        if (!r || r.state === 'own' || r.state === to) continue;
        set.run(to, at, id);
        changes.push({ commentId: id, from: r.state, to });
        stored.push({ commentId: id, from: r.state, fromSource: r.state_source });
      }
      const res = db
        .prepare('INSERT INTO triage_actions (created_at, to_state, changes) VALUES (?, ?, ?)')
        .run(at, to, JSON.stringify(stored));
      return { actionId: Number(res.lastInsertRowid), changes, counts: counts() };
    })();
  }

  function undo(actionId: number): TriageResult {
    return db.transaction(() => {
      const a = db.prepare('SELECT * FROM triage_actions WHERE id = ?').get(actionId) as Row | undefined;
      if (!a) throw new UndoError('not_found', `No such action ${actionId}`);
      if (a.undone_at) throw new UndoError('already_undone', `Action ${actionId} was already undone`);
      if (clock().getTime() - new Date(a.created_at).getTime() >= UNDO_WINDOW_MS) {
        throw new UndoError('expired', `Action ${actionId} is older than 24 hours`);
      }
      const at = now();
      const stored = JSON.parse(a.changes) as { commentId: string; from: CommentState; fromSource?: string }[];
      const restore = db.prepare(
        `UPDATE comments SET state = ?, state_source = ?, state_changed_at = ? WHERE id = ? AND state = ?`,
      );
      const changes: TriageResult['changes'] = [];
      for (const c of stored) {
        const res = restore.run(c.from, c.fromSource ?? 'user', at, c.commentId, a.to_state);
        if (res.changes) changes.push({ commentId: c.commentId, from: a.to_state, to: c.from });
      }
      db.prepare('UPDATE triage_actions SET undone_at = ? WHERE id = ?').run(at, actionId);
      return { actionId, changes, counts: counts() };
    })();
  }

  /* ---------------- drafts ---------------- */
  function draftDto(r: Row): DraftDTO {
    return { body: r.body, updatedAt: r.updated_at, status: r.status };
  }
  function getDraft(commentId: string): DraftDTO | null {
    const r = db.prepare('SELECT * FROM drafts WHERE comment_id = ?').get(commentId) as Row | undefined;
    return r ? draftDto(r) : null;
  }
  function saveDraft(commentId: string, body: string, status: DraftDTO['status']): DraftDTO {
    db.prepare(
      `INSERT INTO drafts (comment_id, body, updated_at, status) VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
         status = excluded.status`,
    ).run(commentId, body, now(), status);
    return getDraft(commentId)!;
  }

  function markHandedOff(commentId: string, body: string): TriageResult {
    return db.transaction(() => {
      if (!getComment(commentId)) throw new Error(`Unknown comment ${commentId}`);
      saveDraft(commentId, body, 'handed_off');
      return triage([commentId], 'replied');
    })();
  }

  /* ---------------- quota and runs ---------------- */
  function runSummary(r: Row): SyncRunSummary {
    return {
      id: r.id,
      trigger: r.trigger,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      units: r.units ?? 0,
      videos: r.videos ?? 0,
      newComments: r.new_comments ?? 0,
      error: r.error,
    };
  }

  return {
    close: () => void db.close(),
    getSettings,
    updateSettings,
    listSources,
    getSourceRow,
    enabledSourceRows: () =>
      (db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY id').all() as Row[]).map(sourceRow),
    addSource,
    updateSource,
    deleteSource,
    setSourceVideos,
    upsertVideos,
    listVideos,
    setVideoTier,
    dueVideos,
    allVideoRows,
    getVideoSyncRow,
    updateVideoSync,
    getThreadState,
    markRepliesFetched,
    upsertThread,
    addReplies,
    recomputeOwnership,
    listInbox,
    getThread,
    getComment,
    triage,
    undo,
    markHandedOff,
    getDraft,
    putDraft: (commentId, body) => saveDraft(commentId, body, 'draft'),
    deleteDraft: (commentId) => void db.prepare('DELETE FROM drafts WHERE comment_id = ?').run(commentId),
    counts,
    recordQuota(dayPt, endpoint, units) {
      db.prepare(
        `INSERT INTO quota_ledger (day_pt, endpoint, units, calls) VALUES (?, ?, ?, 1)
         ON CONFLICT(day_pt, endpoint) DO UPDATE SET units = units + excluded.units, calls = calls + 1`,
      ).run(dayPt, endpoint, units);
    },
    quotaUsed: (dayPt) =>
      (db.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM quota_ledger WHERE day_pt = ?').get(dayPt) as Row).n,
    quotaByEndpoint: (dayPt) =>
      db.prepare('SELECT endpoint, units, calls FROM quota_ledger WHERE day_pt = ? ORDER BY endpoint').all(dayPt) as {
        endpoint: string;
        units: number;
        calls: number;
      }[],
    startRun: (trigger, scope) =>
      Number(
        db.prepare('INSERT INTO sync_runs (trigger, scope, started_at) VALUES (?, ?, ?)').run(trigger, scope, now())
          .lastInsertRowid,
      ),
    finishRun(id, p) {
      db.prepare(
        'UPDATE sync_runs SET finished_at = ?, units = ?, videos = ?, new_comments = ?, error = ? WHERE id = ?',
      ).run(now(), p.units, p.videos, p.newComments, p.error, id);
      return runSummary(db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as Row);
    },
    lastRun() {
      const r = db.prepare('SELECT * FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as
        Row | undefined;
      return r ? runSummary(r) : null;
    },
  };
}

export function openRepo(path: string, clock?: () => Date): Repo {
  return createRepo(openDb(path), clock);
}
