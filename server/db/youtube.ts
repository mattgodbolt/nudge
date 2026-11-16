import type {
  CommentState,
  ImportMode,
  PollTier,
  SourceDTO,
  StatsDTO,
  StatsTotals,
  VideoDTO,
} from '../../shared/types.js';
import type { NewSource, Repo, SourceRow, VideoSyncRow, YtComment, YtThread, YtVideo } from '../contracts.js';
import { tierFor, unitsPerDay } from '../sync/tiers.js';
import { iso, type Row } from './common.js';
import type { Db } from './db.js';
import type { Events } from './events.js';
import { htmlToPlain } from './text.js';
import { wakeOnActivity } from './wake.js';

const EPOCH = '1970-01-01T00:00:00.000Z';
const OWN_FEED_UNITS_PER_DAY = 144; // allThreadsRelatedToChannelId every 10 min

/** A video row plus its inbox count, as videoDto wants it. */
export const VIDEO_SELECT = `SELECT v.*, (SELECT COUNT(*) FROM items i WHERE i.provider = 'youtube' AND i.container_key = v.id AND i.state = 'inbox') AS inbox_count
  FROM videos v`;

export function videoDto(r: Row, at: Date): VideoDTO {
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

export interface YoutubeStore extends Pick<
  Repo,
  | 'listSources'
  | 'getSourceRow'
  | 'enabledSourceRows'
  | 'addSource'
  | 'updateSource'
  | 'deleteSource'
  | 'setSourceVideos'
  | 'upsertVideos'
  | 'getStats'
  | 'videosMissingDetails'
  | 'listVideos'
  | 'setVideoTier'
  | 'dueVideos'
  | 'allVideoRows'
  | 'getVideoSyncRow'
  | 'updateVideoSync'
  | 'getThreadState'
  | 'markRepliesFetched'
  | 'upsertThread'
  | 'addReplies'
  | 'recomputeOwnership'
  | 'removeLocalComment'
  | 'setThreadCanReply'
> {
  /** Where a new source's (or feed's) history starts for an import mode. */
  baselineFor(mode: ImportMode): string;
}

export interface YoutubeDeps {
  db: Db;
  clock: () => Date;
  now: () => string;
  events: Events;
  getSettings: Repo['getSettings'];
  /** Stores a setting without side effects (recomputeOwnership saves the new own channel ids itself). */
  putSetting: (key: string, json: string) => void;
}

/** YouTube data: videos and their stats, sources, threads and comments, and own-channel ownership. */
export function createYoutube(deps: YoutubeDeps): YoutubeStore {
  const { db, clock, now, events, getSettings } = deps;
  const ownIds = () => getSettings().ownChannelIds;

  /* ---------------- videos ---------------- */
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
        (id, channel_id, channel_title, title, thumbnail_url, published_at, view_count, comment_count, duration_seconds, like_count, meta_refreshed_at, next_sync_at)
      VALUES (@id, @channelId, @channelTitle, @title, @thumbnailUrl, @publishedAt, @viewCount, @commentCount, @durationSeconds, @likeCount, @at, @at)
      ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, channel_title = excluded.channel_title,
        title = excluded.title, thumbnail_url = excluded.thumbnail_url, published_at = excluded.published_at,
        view_count = excluded.view_count, comment_count = excluded.comment_count,
        duration_seconds = COALESCE(excluded.duration_seconds, duration_seconds),
        like_count = COALESCE(excluded.like_count, like_count),
        meta_refreshed_at = excluded.meta_refreshed_at,
        last_error = CASE WHEN missing = 1 THEN NULL ELSE last_error END,
        missing = 0`);
    const at = now();
    const retitle = db.prepare("UPDATE items SET container_title = ? WHERE provider = 'youtube' AND container_key = ?");
    db.transaction(() => {
      for (const v of vs) {
        stmt.run({
          durationSeconds: null,
          likeCount: null,
          ...v,
          publishedAt: v.publishedAt ? iso(v.publishedAt) : null,
          at,
        });
        retitle.run(v.title, v.id);
      }
    })();
  }

  /** Every tracked video exactly once, however many sources list it; `mine` = reachable from an own-channel source. */
  const TRACKED = `SELECT sv.video_id AS id, MAX(s.is_own) AS mine FROM source_videos sv
      JOIN sources s ON s.id = sv.source_id GROUP BY sv.video_id`;

  function statsTotals(onlyMine: boolean): StatsTotals {
    const where = `v.missing = 0${onlyMine ? ' AND t.mine = 1' : ''}`;
    const v = db
      .prepare(
        `SELECT COUNT(*) AS videos, COUNT(v.duration_seconds) AS withDetails,
           COALESCE(SUM(v.duration_seconds), 0) AS dur, COALESCE(SUM(v.view_count), 0) AS views,
           COALESCE(SUM(v.like_count), 0) AS likes, COALESCE(SUM(v.comment_count), 0) AS ytComments
         FROM (${TRACKED}) t JOIN videos v ON v.id = t.id WHERE ${where}`,
      )
      .get() as Row;
    const c = db
      .prepare(
        `SELECT COALESCE(SUM(c.is_own = 0), 0) AS synced, COALESCE(SUM(CASE WHEN c.is_own = 0 THEN c.like_count END), 0) AS likes,
           COALESCE(SUM(c.is_own = 1 AND c.parent_id IS NOT NULL), 0) AS ownReplies,
           COALESCE(SUM(i.state = 'inbox'), 0) AS inbox
         FROM (${TRACKED}) t JOIN videos v ON v.id = t.id JOIN comments c ON c.video_id = v.id
         JOIN items i ON i.id = c.id WHERE ${where}`,
      )
      .get() as Row;
    return {
      videos: v.videos,
      videosWithDetails: v.withDetails,
      durationSeconds: v.dur,
      views: v.views,
      videoLikes: v.likes,
      commentsOnYoutube: v.ytComments,
      commentsSynced: c.synced,
      commentLikes: c.likes,
      ownReplies: c.ownReplies,
      inbox: c.inbox,
    };
  }

  function getStats(): StatsDTO {
    const rows = db
      .prepare(
        `SELECT s.id, s.kind, s.title, s.yt_id, s.is_own,
           COUNT(v.id) AS videos, COALESCE(SUM(v.duration_seconds), 0) AS dur, COALESCE(SUM(v.view_count), 0) AS views,
           COALESCE(SUM(v.like_count), 0) AS likes, COALESCE(SUM(v.comment_count), 0) AS ytComments,
           COALESCE(SUM(cs.synced), 0) AS synced, COALESCE(SUM(cs.likes), 0) AS commentLikes
         FROM sources s
         LEFT JOIN source_videos sv ON sv.source_id = s.id
         LEFT JOIN videos v ON v.id = sv.video_id AND v.missing = 0
         LEFT JOIN (SELECT video_id, SUM(is_own = 0) AS synced,
                           SUM(CASE WHEN is_own = 0 THEN like_count ELSE 0 END) AS likes
                    FROM comments GROUP BY video_id) cs ON cs.video_id = v.id
         GROUP BY s.id ORDER BY dur DESC, s.id`,
      )
      .all() as Row[];
    return {
      totals: statsTotals(false),
      mine: statsTotals(true),
      bySource: rows.map((r) => ({
        sourceId: r.id,
        kind: r.kind,
        title: r.title ?? r.yt_id,
        isOwn: !!r.is_own,
        videos: r.videos,
        durationSeconds: r.dur,
        views: r.views,
        videoLikes: r.likes,
        commentsOnYoutube: r.ytComments,
        commentsSynced: r.synced,
        commentLikes: r.commentLikes,
      })),
    };
  }

  function videosMissingDetails(): string[] {
    return (
      db
        .prepare(
          `SELECT v.id FROM videos v WHERE v.missing = 0 AND v.duration_seconds IS NULL AND v.meta_refreshed_at IS NOT NULL
             AND v.id IN (SELECT video_id FROM source_videos)`,
        )
        .all() as Row[]
    ).map((r) => r.id);
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
            `SELECT sv.source_id, COUNT(*) AS n FROM items i JOIN source_videos sv ON sv.video_id = i.container_key
             WHERE i.provider = 'youtube' AND i.state = 'inbox' GROUP BY sv.source_id`,
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
    const map: Record<string, [string, (v: unknown) => unknown]> = {
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

  // Prepared once: upsertComment runs for every comment of every thread a sync fetches.
  const commentText = db.prepare('SELECT text_html FROM comments WHERE id = ?');
  const refreshComment = db.prepare(
    `UPDATE comments SET text_html = ?, text_plain = ?, like_count = ?, updated_at = ?, author_name = ?,
       author_avatar_url = ? WHERE id = ?`,
  );
  const refreshCommentItem = db.prepare(
    'UPDATE items SET body_plain = ?, author = ?, author_avatar_url = ? WHERE id = ?',
  );
  const insertComment = db.prepare(
    `INSERT INTO comments (id, thread_id, parent_id, video_id, author_name, author_channel_id, author_avatar_url,
       text_html, text_plain, like_count, published_at, updated_at, first_seen_at, is_own)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCommentItem = db.prepare(
    `INSERT INTO items (id, provider, kind, container_key, container_title, author, author_avatar_url, is_own,
       body_plain, occurred_at, state, state_source, state_changed_at, first_seen_at)
     VALUES (?, 'youtube', 'comment', ?, (SELECT title FROM videos WHERE id = ?), ?, ?, ?, ?, ?, ?, 'sync', ?, ?)`,
  );

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
    const existing = commentText.get(c.id) as Row | undefined;
    if (existing) {
      const textChanged = existing.text_html !== c.textHtml;
      refreshComment.run(
        c.textHtml,
        htmlToPlain(c.textHtml),
        c.likeCount,
        updated,
        c.authorName,
        c.authorAvatarUrl,
        c.id,
      );
      refreshCommentItem.run(htmlToPlain(c.textHtml), c.authorName, c.authorAvatarUrl, c.id);
      return textChanged ? 'changed' : 'same';
    }
    const isOwn = c.authorChannelId != null && ctx.own.includes(c.authorChannelId);
    const state: CommentState = isOwn ? 'own' : ctx.baseline && published < ctx.baseline ? 'archived' : 'inbox';
    insertComment.run(
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
    );
    insertCommentItem.run(
      c.id,
      videoId,
      videoId,
      c.authorName,
      c.authorAvatarUrl,
      isOwn ? 1 : 0,
      htmlToPlain(c.textHtml),
      published,
      state,
      ctx.at,
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
          `SELECT i.id FROM items i JOIN comments c ON c.id = i.id
           WHERE c.thread_id = ? AND i.state = 'inbox' AND i.state_source != 'user' AND c.published_at < ?`,
        )
        .all(threadId, lastOwn) as Row[]
    ).map((x) => x.id as string);
    if (ids.length) {
      const at = now();
      for (const id of ids) {
        events.record({
          itemId: id,
          at,
          kind: 'state',
          from: 'inbox',
          to: 'auto_replied',
          source: 'auto',
          meta: { reason: 'own_reply', threadId },
        });
      }
      db.prepare(
        `UPDATE items SET state = 'auto_replied', state_source = 'auto', state_changed_at = ?
         WHERE state = 'inbox' AND state_source != 'user'
           AND id IN (SELECT id FROM comments WHERE thread_id = ? AND published_at < ?)`,
      ).run(at, threadId, lastOwn);
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

  /**
   * Wake items on a thread that are snoozed until activity, because comments from someone else just arrived on it.
   * The owner's own replies and comments older than the snooze (a backfill) do not count.
   */
  function wakeThreadOnReplies(threadId: string, newIds: string[]): string[] {
    if (newIds.length === 0) return [];
    const newest = db
      .prepare(
        `SELECT MAX(c.published_at) AS m FROM comments c JOIN items i ON i.id = c.id
          WHERE c.id IN (SELECT value FROM json_each(?)) AND c.is_own = 0 AND i.state NOT IN ('own', 'archived')`,
      )
      .get(JSON.stringify(newIds)) as Row;
    if (!newest.m) return [];
    const at = now();
    const waiting = (
      db
        .prepare(
          `SELECT i.id FROM items i JOIN comments c ON c.id = i.id
            WHERE c.thread_id = ? AND i.snooze_until_activity = 1 AND i.snoozed_until > ? AND i.snoozed_at < ?
              AND i.id NOT IN (SELECT value FROM json_each(?))`,
        )
        .all(threadId, at, newest.m, JSON.stringify(newIds)) as Row[]
    ).map((r) => r.id as string);
    return wakeOnActivity(db, events, waiting, at, { trigger: 'reply' });
  }

  function upsertThread(t: YtThread): { newCommentIds: string[]; changedIds: string[]; wokenIds: string[] } {
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
      const wokenIds = wakeThreadOnReplies(t.id, newIds);
      for (const id of applyOwnReplies(t.id)) if (!newIds.includes(id) && !changed.includes(id)) changed.push(id);
      return { newCommentIds: newIds, changedIds: changed, wokenIds };
    })();
  }

  function addReplies(
    threadId: string,
    replies: YtComment[],
  ): { newCommentIds: string[]; changedIds: string[]; wokenIds: string[] } {
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
      const wokenIds = wakeThreadOnReplies(threadId, newIds);
      for (const id of applyOwnReplies(threadId)) if (!newIds.includes(id) && !changed.includes(id)) changed.push(id);
      return { newCommentIds: newIds, changedIds: changed, wokenIds };
    })();
  }

  function recomputeOwnership(ids: string[]): void {
    db.transaction(() => {
      const at = now();
      const json = JSON.stringify(ids);
      deps.putSetting('ownChannelIds', json);
      db.prepare(
        `UPDATE comments SET is_own = CASE WHEN author_channel_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END`,
      ).run(json);
      db.prepare(
        "UPDATE items SET is_own = (SELECT is_own FROM comments WHERE id = items.id) WHERE provider = 'youtube'",
      ).run();
      db.prepare(
        `UPDATE threads SET own_last_reply_at =
           (SELECT MAX(published_at) FROM comments c WHERE c.thread_id = threads.id AND c.is_own = 1)`,
      ).run();
      const fallback = `CASE WHEN occurred_at < (SELECT baseline_at FROM videos WHERE id = items.container_key)
                         THEN 'archived' ELSE 'inbox' END`;
      const ownLastReply =
        '(SELECT own_last_reply_at FROM threads WHERE id = (SELECT thread_id FROM comments WHERE id = items.id))';
      // Newly-own comments leave whatever (non-user) state they had.
      const meta = { reason: 'ownership_changed' };
      events.recordStateMoves(
        "provider = 'youtube' AND is_own = 1 AND state != 'own' AND state_source != 'user'",
        [],
        "'own'",
        'sync',
        at,
        meta,
      );
      db.prepare(
        `UPDATE items SET state = 'own', state_source = 'sync', state_changed_at = ?
         WHERE provider = 'youtube' AND is_own = 1 AND state != 'own' AND state_source != 'user'`,
      ).run(at);
      // No-longer-own comments go back to inbox/archived.
      events.recordStateMoves("provider = 'youtube' AND is_own = 0 AND state = 'own'", [], fallback, 'sync', at, meta);
      db.prepare(
        `UPDATE items SET state = ${fallback}, state_source = 'sync', state_changed_at = ?
         WHERE provider = 'youtube' AND is_own = 0 AND state = 'own'`,
      ).run(at);
      // Auto-cleared rows whose justifying own reply has vanished go back.
      events.recordStateMoves(
        `provider = 'youtube' AND state = 'auto_replied' AND state_source = 'auto'
           AND NOT COALESCE(occurred_at < ${ownLastReply}, 0)`,
        [],
        fallback,
        'sync',
        at,
        meta,
      );
      db.prepare(
        `UPDATE items SET state = ${fallback}, state_source = 'sync', state_changed_at = ?
         WHERE provider = 'youtube' AND state = 'auto_replied' AND state_source = 'auto'
           AND NOT COALESCE(occurred_at < ${ownLastReply}, 0)`,
      ).run(at);
      // Re-run auto-clear everywhere.
      events.recordStateMoves(
        `provider = 'youtube' AND state = 'inbox' AND state_source != 'user' AND occurred_at < ${ownLastReply}`,
        [],
        "'auto_replied'",
        'auto',
        at,
        { reason: 'own_reply' },
      );
      db.prepare(
        `UPDATE items SET state = 'auto_replied', state_source = 'auto', state_changed_at = ?
         WHERE provider = 'youtube' AND state = 'inbox' AND state_source != 'user' AND occurred_at < ${ownLastReply}`,
      ).run(at);
    })();
  }

  function removeLocalComment(commentId: string): void {
    db.transaction(() => {
      const r = db.prepare('SELECT thread_id, parent_id FROM comments WHERE id = ?').get(commentId) as Row | undefined;
      if (!r) return;
      // Replies are never top-level here; deleting a top-level comment cascades the whole thread via FK.
      db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
      if (r.parent_id !== null) {
        refreshThreadStats(r.thread_id);
        applyOwnReplies(r.thread_id);
      }
    })();
  }

  function setThreadCanReply(threadId: string, canReply: boolean): void {
    db.prepare('UPDATE threads SET can_reply = ? WHERE id = ?').run(canReply ? 1 : 0, threadId);
  }

  return {
    listSources,
    getSourceRow,
    enabledSourceRows: () =>
      (db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY id').all() as Row[]).map(sourceRow),
    addSource,
    updateSource,
    deleteSource,
    setSourceVideos,
    upsertVideos,
    getStats,
    videosMissingDetails,
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
    removeLocalComment,
    setThreadCanReply,
    baselineFor,
  };
}
