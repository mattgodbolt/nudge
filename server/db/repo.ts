/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  CommentDTO,
  CommentState,
  Counts,
  ImportMode,
  InboxItem,
  LabelApplyResult,
  LabelColor,
  LabelDTO,
  PollTier,
  PushPrefs,
  SnoozeResult,
  SourceDTO,
  StatsDTO,
  StatsTotals,
  SyncRunSummary,
  ThreadDetail,
  TriageResult,
  VideoDTO,
} from '../../shared/types.js';
import { LABEL_COLORS, MAX_LABEL_NAME, MAX_LABELS } from '../../shared/types.js';
import type { DraftDTO, InboxPage, InboxQuery } from '../../shared/api.js';
import { permalink } from '../../shared/youtube-urls.js';
import { LabelError } from '../contracts.js';
import type {
  GoogleAccountRow,
  NewSource,
  PushSubscriptionRow,
  Repo,
  SourceRow,
  StoredSettings,
  VideoSyncRow,
  YtComment,
  YtThread,
  YtVideo,
} from '../contracts.js';
import { openDb, type Db } from './db.js';
import { createFeedsRepo } from './feeds.js';
import { createTodosRepo } from './todos.js';
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
  googleClient: null,
  ownChannelIds: [],
  pollEnabled: true,
  dailyQuotaBudget: 9000,
  manualReserve: 1000,
  backfillDays: 14,
  theme: 'system',
  github: { token: null, myAccounts: [] },
  llm: { apiKey: null, model: 'claude-haiku-5-5' },
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
    postedByApp: !!r.posted_by_app,
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
  const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  const feeds = createFeedsRepo({
    db,
    now,
    myAccounts: () => new Set(getSettings().github.myAccounts.map((l) => l.toLowerCase())),
    baselineFor: (mode) => baselineFor(mode),
  });

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
      if (p.github && JSON.stringify(p.github.myAccounts) !== JSON.stringify(before.github.myAccounts)) {
        feeds.recomputeGithubOwnership();
      }
    })();
    return getSettings();
  }

  /* ---------------- web push ---------------- */
  const pushRow = (r: Row): PushSubscriptionRow => ({
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    newComments: !!r.new_comments,
    snoozeWake: !!r.snooze_wake,
    label: r.label,
    createdAt: r.created_at,
    lastSuccessAt: r.last_success_at,
    failureCount: r.failure_count,
  });
  const listPushSubscriptions = (): PushSubscriptionRow[] =>
    (db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at, endpoint').all() as Row[]).map(pushRow);
  function getPushSubscription(endpoint: string): PushSubscriptionRow | null {
    const r = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as Row | undefined;
    return r ? pushRow(r) : null;
  }
  function upsertPushSubscription(s: {
    endpoint: string;
    p256dh: string;
    auth: string;
    label: string | null;
    prefs: PushPrefs;
  }): void {
    db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, new_comments, snooze_wake, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         new_comments = excluded.new_comments, snooze_wake = excluded.snooze_wake, label = excluded.label,
         failure_count = 0`,
    ).run(s.endpoint, s.p256dh, s.auth, s.prefs.newComments ? 1 : 0, s.prefs.snoozeWake ? 1 : 0, s.label, now());
  }
  const deletePushSubscription = (endpoint: string): boolean =>
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
  function markPushResult(endpoint: string, ok: boolean): void {
    if (ok) {
      db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE endpoint = ?').run(
        now(),
        endpoint,
      );
    } else {
      db.prepare('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE endpoint = ?').run(endpoint);
    }
  }
  function getVapidKeys(): { publicKey: string; privateKey: string } | null {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'vapidKeys'").get() as Row | undefined;
    if (!r) return null;
    try {
      const v = JSON.parse(r.value);
      return typeof v?.publicKey === 'string' && typeof v?.privateKey === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  const setVapidKeys = (k: { publicKey: string; privateKey: string }): void =>
    void putSetting.run('vapidKeys', JSON.stringify(k));

  /* ---------------- videos ---------------- */
  const VIDEO_SELECT = `SELECT v.*, (SELECT COUNT(*) FROM items i WHERE i.provider = 'youtube' AND i.container_key = v.id AND i.state = 'inbox') AS inbox_count
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
        (id, channel_id, channel_title, title, thumbnail_url, published_at, view_count, comment_count, duration_seconds, like_count, meta_refreshed_at, next_sync_at)
      VALUES (@id, @channelId, @channelTitle, @title, @thumbnailUrl, @publishedAt, @viewCount, @commentCount, @durationSeconds, @likeCount, @at, @at)
      ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, channel_title = excluded.channel_title,
        title = excluded.title, thumbnail_url = excluded.thumbnail_url, published_at = excluded.published_at,
        view_count = excluded.view_count, comment_count = excluded.comment_count,
        duration_seconds = COALESCE(excluded.duration_seconds, duration_seconds),
        like_count = COALESCE(excluded.like_count, like_count),
        meta_refreshed_at = excluded.meta_refreshed_at`);
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
      db.prepare('UPDATE items SET body_plain = ?, author = ?, author_avatar_url = ? WHERE id = ?').run(
        htmlToPlain(c.textHtml),
        c.authorName,
        c.authorAvatarUrl,
        c.id,
      );
      return textChanged ? 'changed' : 'same';
    }
    const isOwn = c.authorChannelId != null && ctx.own.includes(c.authorChannelId);
    const state: CommentState = isOwn ? 'own' : ctx.baseline && published < ctx.baseline ? 'archived' : 'inbox';
    db.prepare(
      `INSERT INTO comments (id, thread_id, parent_id, video_id, author_name, author_channel_id, author_avatar_url,
         text_html, text_plain, like_count, published_at, updated_at, first_seen_at, is_own)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    db.prepare(
      `INSERT INTO items (id, provider, kind, container_key, container_title, author, author_avatar_url, is_own,
         body_plain, occurred_at, state, state_source, state_changed_at, first_seen_at)
       VALUES (?, 'youtube', 'comment', ?, (SELECT title FROM videos WHERE id = ?), ?, ?, ?, ?, ?, ?, 'sync', ?, ?)`,
    ).run(
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
      db.prepare(
        `UPDATE items SET state = 'auto_replied', state_source = 'auto', state_changed_at = ?
         WHERE state = 'inbox' AND state_source != 'user'
           AND id IN (SELECT id FROM comments WHERE thread_id = ? AND published_at < ?)`,
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
      db.prepare(
        `UPDATE items SET state = 'own', state_source = 'sync', state_changed_at = ?
         WHERE provider = 'youtube' AND is_own = 1 AND state != 'own' AND state_source != 'user'`,
      ).run(at);
      // No-longer-own comments go back to inbox/archived.
      db.prepare(
        `UPDATE items SET state = ${fallback}, state_source = 'sync', state_changed_at = ?
         WHERE provider = 'youtube' AND is_own = 0 AND state = 'own'`,
      ).run(at);
      // Auto-cleared rows whose justifying own reply has vanished go back.
      db.prepare(
        `UPDATE items SET state = ${fallback}, state_source = 'sync', state_changed_at = ?
         WHERE provider = 'youtube' AND state = 'auto_replied' AND state_source = 'auto'
           AND NOT COALESCE(occurred_at < ${ownLastReply}, 0)`,
      ).run(at);
      // Re-run auto-clear everywhere.
      db.prepare(
        `UPDATE items SET state = 'auto_replied', state_source = 'auto', state_changed_at = ?
         WHERE provider = 'youtube' AND state = 'inbox' AND state_source != 'user' AND occurred_at < ${ownLastReply}`,
      ).run(at);
    })();
  }

  /* ---------------- reading ---------------- */
  const INBOX_SELECT = `SELECT c.*, i.id AS item_id, i.provider, i.kind, i.title AS i_title, i.author AS i_author,
      i.author_avatar_url AS i_avatar, i.is_own AS i_own, i.body_plain, i.url AS i_url, i.container_key,
      i.container_title, i.source_state, i.reason, i.muted, i.data, i.occurred_at,
      i.state, i.state_source, i.state_changed_at, i.snoozed_until, i.woke_at,
      v.title AS v_title, v.thumbnail_url AS v_thumb,
      p.id AS p_id, p.author_name AS p_author, p.text_plain AS p_text, p.is_own AS p_own,
      t.total_reply_count AS t_total,
      EXISTS (SELECT 1 FROM drafts d WHERE d.item_id = i.id AND d.status = 'draft') AS has_draft
    FROM items i
    LEFT JOIN comments c ON c.id = i.id
    LEFT JOIN videos v ON v.id = c.video_id
    LEFT JOIN threads t ON t.id = c.thread_id
    LEFT JOIN comments p ON p.id = c.parent_id`;

  /** SQL fragments for "needs attention now" (inbox state and not currently snoozed); bind @now. */
  const NOT_SNOOZED = '(i.snoozed_until IS NULL OR i.snoozed_until <= @now)';
  const SORT_VALUE = 'COALESCE(i.woke_at, i.occurred_at)';

  function inboxItem(r: Row, labels: number[], at: string): InboxItem {
    const item = feeds.itemFromRow(r);
    const youtube = r.provider === 'youtube';
    // Non-YouTube items get a comment-shaped stand-in so selection, snooze, labels and undo work unchanged.
    const comment: CommentDTO = youtube
      ? commentDto({ ...r, id: r.item_id })
      : {
          id: r.item_id,
          threadId: r.item_id,
          parentId: null,
          videoId: r.container_key ?? '',
          authorName: r.i_author ?? '',
          authorChannelId: null,
          authorAvatarUrl: r.i_avatar ?? null,
          textHtml: escapeHtml(r.body_plain ?? ''),
          textPlain: r.body_plain ?? '',
          likeCount: 0,
          publishedAt: r.occurred_at,
          updatedAt: r.occurred_at,
          isOwn: !!r.i_own,
          state: r.state,
          stateSource: r.state_source,
          permalink: r.i_url ?? '',
          postedByApp: false,
        };
    return {
      item,
      comment,
      video: youtube
        ? { id: r.video_id, title: r.v_title, thumbnailUrl: r.v_thumb }
        : { id: r.container_key ?? '', title: r.container_title ?? '', thumbnailUrl: null },
      parent: r.p_id ? { id: r.p_id, authorName: r.p_author, textPlain: r.p_text, isOwn: !!r.p_own } : null,
      threadReplyCount: r.t_total ?? 0,
      hasDraft: !!r.has_draft,
      labels,
      snoozedUntil: r.snoozed_until && r.snoozed_until > at ? r.snoozed_until : null,
      wokeAt: r.woke_at ?? null,
    };
  }

  /** Label ids per comment for one page of rows, in a single query. */
  function labelsFor(ids: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    if (ids.length === 0) return out;
    for (const r of db
      .prepare(
        'SELECT item_id, label_id FROM item_labels WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY label_id',
      )
      .all(JSON.stringify(ids)) as Row[]) {
      const list = out.get(r.item_id);
      if (list) list.push(r.label_id);
      else out.set(r.item_id, [r.label_id]);
    }
    return out;
  }

  function listInbox(q: InboxQuery): InboxPage {
    const where: string[] = [];
    const at = now();
    const args: Record<string, unknown> = { now: at };
    if (q.view === 'inbox') where.push(`i.state = 'inbox' AND ${NOT_SNOOZED}`);
    else if (q.view === 'snoozed') where.push("i.state = 'inbox' AND i.snoozed_until > @now");
    else if (q.view === 'done') where.push("i.state IN ('done','replied','auto_replied','resolved')");
    else where.push("i.state != 'own'");
    if (q.sourceId !== undefined) {
      where.push(
        "i.provider = 'youtube' AND i.container_key IN (SELECT video_id FROM source_videos WHERE source_id = @sourceId)",
      );
      args.sourceId = q.sourceId;
    }
    if (q.videoId) {
      where.push('i.container_key = @videoId');
      args.videoId = q.videoId;
    }
    if (q.feedId !== undefined) {
      where.push('i.feed_id = @feedId');
      args.feedId = q.feedId;
    }
    if (q.kind) {
      where.push('i.kind = @kind');
      args.kind = q.kind;
    }
    if (q.audience) {
      const assoc = "json_extract(i.data, '$.association')";
      const bot = "COALESCE(json_extract(i.data, '$.authorType'), '') = 'Bot'";
      const by: Record<string, string> = {
        outside: `${assoc} IN ('NONE','FIRST_TIME_CONTRIBUTOR','FIRST_TIMER','MANNEQUIN') AND NOT ${bot}`,
        team: `${assoc} IN ('OWNER','MEMBER','COLLABORATOR') AND NOT ${bot}`,
        contributors: `${assoc} = 'CONTRIBUTOR' AND NOT ${bot}`,
        bots: bot,
        people: `NOT ${bot}`,
      };
      const clause = by[q.audience];
      if (clause) where.push(`i.provider = 'github' AND ${clause}`);
    }
    if (q.labelId !== undefined) {
      where.push('i.id IN (SELECT item_id FROM item_labels WHERE label_id = @labelId)');
      args.labelId = q.labelId;
    }
    if (q.q && q.q.trim()) {
      const fts = ftsQuery(q.q);
      if (!fts) return { items: [], nextCursor: null, total: 0 };
      where.push('i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH @fts)');
      args.fts = fts;
    }
    const base = where.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${base}`).get(args) as Row).n as number;

    const pageWhere = [base];
    const sep = q.cursor ? q.cursor.indexOf('|') : -1;
    if (q.cursor && sep > 0) {
      args.cPub = q.cursor.slice(0, sep);
      args.cId = q.cursor.slice(sep + 1);
      pageWhere.push(`(${SORT_VALUE} < @cPub OR (${SORT_VALUE} = @cPub AND i.id > @cId))`);
    }
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const rows = db
      .prepare(`${INBOX_SELECT} WHERE ${pageWhere.join(' AND ')} ORDER BY ${SORT_VALUE} DESC, i.id ASC LIMIT @lim`)
      .all({ ...args, lim: limit + 1 }) as Row[];
    const more = rows.length > limit;
    const pageRows = more ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const labels = labelsFor(pageRows.map((r) => r.item_id as string));
    return {
      items: pageRows.map((r) => inboxItem(r, labels.get(r.item_id) ?? [], at)),
      nextCursor: more && last ? `${last.woke_at ?? last.occurred_at}|${last.item_id}` : null,
      total,
    };
  }

  function getThread(threadId: string): ThreadDetail | null {
    const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (!t) return null;
    const v = db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(t.video_id) as Row;
    const rows = db
      .prepare(
        `SELECT comments.*, i.state, i.state_source,
           (SELECT 1 FROM reply_posts rp WHERE rp.posted_comment_id = comments.id AND rp.status = 'posted') IS NOT NULL AS posted_by_app
         FROM comments JOIN items i ON i.id = comments.id WHERE thread_id = ?
         ORDER BY (parent_id IS NOT NULL), published_at, comments.id`,
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
    const r = db
      .prepare(
        `SELECT comments.*, i.state, i.state_source,
           (SELECT 1 FROM reply_posts rp WHERE rp.posted_comment_id = comments.id AND rp.status = 'posted') IS NOT NULL AS posted_by_app
         FROM comments JOIN items i ON i.id = comments.id WHERE comments.id = ?`,
      )
      .get(id) as Row | undefined;
    return r ? commentDto(r) : null;
  }

  function counts(): Counts {
    const at = now();
    const by = new Map<string, number>(
      (db.prepare('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all() as Row[]).map((r) => [r.state, r.n]),
    );
    const n = (s: string) => by.get(s) ?? 0;
    const snoozed = (
      db.prepare("SELECT COUNT(*) AS n FROM items WHERE state = 'inbox' AND snoozed_until > ?").get(at) as Row
    ).n as number;
    const bySource: Record<number, number> = {};
    for (const s of db.prepare('SELECT id FROM sources').all() as Row[]) bySource[s.id] = 0;
    for (const r of db
      .prepare(
        `SELECT sv.source_id, COUNT(*) AS n FROM items i JOIN source_videos sv ON sv.video_id = i.container_key
         WHERE i.provider = 'youtube' AND i.state = 'inbox' AND ${NOT_SNOOZED} GROUP BY sv.source_id`,
      )
      .all({ now: at }) as Row[]) {
      bySource[r.source_id] = r.n;
    }
    const byLabel: Record<number, number> = {};
    for (const l of db.prepare('SELECT id FROM labels').all() as Row[]) byLabel[l.id] = 0;
    for (const r of db
      .prepare(
        `SELECT il.label_id, COUNT(*) AS n FROM item_labels il JOIN items i ON i.id = il.item_id
         WHERE i.state = 'inbox' AND ${NOT_SNOOZED} GROUP BY il.label_id`,
      )
      .all({ now: at }) as Row[]) {
      byLabel[r.label_id] = r.n;
    }
    const byFeed: Record<number, number> = {};
    for (const f of db.prepare('SELECT id FROM feeds').all() as Row[]) byFeed[f.id] = 0;
    for (const r of db
      .prepare(
        `SELECT i.feed_id, COUNT(*) AS n FROM items i WHERE i.feed_id IS NOT NULL AND i.state = 'inbox'
           AND ${NOT_SNOOZED} GROUP BY i.feed_id`,
      )
      .all({ now: at }) as Row[]) {
      byFeed[r.feed_id] = r.n;
    }
    const all = [...by.entries()].reduce((a, [s, c]) => (s === 'own' ? a : a + c), 0);
    return {
      inbox: n('inbox') - snoozed,
      done: n('done') + n('replied') + n('auto_replied') + n('resolved'),
      all,
      snoozed,
      bySource,
      byLabel,
      byFeed,
    };
  }

  /* ---------------- triage ---------------- */
  function triage(ids: string[], to: CommentState): TriageResult {
    return db.transaction(() => {
      const at = now();
      const get = db.prepare('SELECT state, state_source FROM items WHERE id = ?');
      const set = db.prepare("UPDATE items SET state = ?, state_source = 'user', state_changed_at = ? WHERE id = ?");
      const changes: { commentId: string; from: CommentState; to: CommentState }[] = [];
      const stored: { commentId: string; from: CommentState; fromSource: string }[] = [];
      // Moving something back to the inbox must show it, so it also loses any snooze (even if already in 'inbox').
      const unsnooze = db.prepare('UPDATE items SET snoozed_until = NULL WHERE id = ? AND snoozed_until IS NOT NULL');
      for (const id of new Set(ids)) {
        const r = get.get(id) as Row | undefined;
        if (!r || r.state === 'own') continue;
        if (to === 'inbox') unsnooze.run(id);
        if (r.state === to) continue;
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

  /** Fetch an undoable action row; snooze actions (to_state 'snoozed') and triage actions never cross over. */
  function loadUndoable(actionId: number, snooze: boolean): Row {
    const a = db.prepare('SELECT * FROM triage_actions WHERE id = ?').get(actionId) as Row | undefined;
    if (!a || (a.to_state === 'snoozed') !== snooze) throw new UndoError('not_found', `No such action ${actionId}`);
    if (a.undone_at) throw new UndoError('already_undone', `Action ${actionId} was already undone`);
    if (clock().getTime() - new Date(a.created_at).getTime() >= UNDO_WINDOW_MS) {
      throw new UndoError('expired', `Action ${actionId} is older than 24 hours`);
    }
    return a;
  }

  function undo(actionId: number): TriageResult {
    return db.transaction(() => {
      const a = loadUndoable(actionId, false);
      const at = now();
      const stored = JSON.parse(a.changes) as { commentId: string; from: CommentState; fromSource?: string }[];
      const restore = db.prepare(
        `UPDATE items SET state = ?, state_source = ?, state_changed_at = ? WHERE id = ? AND state = ?`,
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

  /* ---------------- snooze ---------------- */
  function snooze(ids: string[], until: string | null): SnoozeResult {
    return db.transaction(() => {
      const at = now();
      const target = until === null ? null : iso(until);
      const get = db.prepare('SELECT state, snoozed_until, woke_at FROM items WHERE id = ?');
      const set = db.prepare('UPDATE items SET snoozed_until = ?, woke_at = ? WHERE id = ?');
      const changes: SnoozeResult['changes'] = [];
      const stored: { commentId: string; from: string | null; fromWoke: string | null; to: string | null }[] = [];
      for (const id of new Set(ids)) {
        const r = get.get(id) as Row | undefined;
        if (!r || r.state !== 'inbox') continue;
        // A past value is an already-ended snooze the waker has not swept yet: effectively not snoozed.
        const from: string | null = r.snoozed_until && r.snoozed_until > at ? r.snoozed_until : null;
        const fromWoke: string | null = r.woke_at ?? null;
        if (target === null ? from === null : from === target && fromWoke === null) continue;
        set.run(target, target === null ? fromWoke : null, id);
        changes.push({ commentId: id, from, to: target });
        stored.push({ commentId: id, from, fromWoke, to: target });
      }
      if (changes.length === 0) return { actionId: null, changes, counts: counts() };
      const res = db
        .prepare('INSERT INTO triage_actions (created_at, to_state, changes) VALUES (?, ?, ?)')
        .run(at, 'snoozed', JSON.stringify(stored));
      return { actionId: Number(res.lastInsertRowid), changes, counts: counts() };
    })();
  }

  function undoSnooze(actionId: number): SnoozeResult {
    return db.transaction(() => {
      const a = loadUndoable(actionId, true);
      const stored = JSON.parse(a.changes) as {
        commentId: string;
        from: string | null;
        fromWoke: string | null;
        to: string | null;
      }[];
      // Only restore comments still in the state this action left them in.
      const restore = db.prepare(
        `UPDATE items SET snoozed_until = ?, woke_at = ?
         WHERE id = ? AND state = 'inbox' AND snoozed_until IS ?`,
      );
      const changes: SnoozeResult['changes'] = [];
      for (const c of stored) {
        if (restore.run(c.from, c.fromWoke, c.commentId, c.to).changes) {
          changes.push({ commentId: c.commentId, from: c.to, to: c.from });
        }
      }
      db.prepare('UPDATE triage_actions SET undone_at = ? WHERE id = ?').run(now(), actionId);
      return { actionId, changes, counts: counts() };
    })();
  }

  function wakeSnoozed(): { woken: string[]; counts: Counts } {
    return db.transaction(() => {
      const at = now();
      const due = db
        .prepare('SELECT id, state FROM items WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?')
        .all(at) as Row[];
      if (due.length === 0) return { woken: [], counts: counts() };
      db.prepare(
        'UPDATE items SET woke_at = snoozed_until, snoozed_until = NULL WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?',
      ).run(at);
      // Only inbox comments change what the user sees; others are tidied silently.
      return { woken: due.filter((r) => r.state === 'inbox').map((r) => r.id as string), counts: counts() };
    })();
  }

  /* ---------------- labels ---------------- */
  const labelDto = (r: Row): LabelDTO => ({ id: r.id, name: r.name, color: r.color, position: r.position });
  const getLabel = (id: number): LabelDTO | null => {
    const r = db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as Row | undefined;
    return r ? labelDto(r) : null;
  };

  function listLabels(): LabelDTO[] {
    return (db.prepare('SELECT * FROM labels ORDER BY position, id').all() as Row[]).map(labelDto);
  }

  function cleanLabelName(name: string, exceptId?: number): string {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (clean === '') throw new LabelError('bad_name', 'Label name must not be empty');
    if ([...clean].length > MAX_LABEL_NAME) {
      throw new LabelError('bad_name', `Label name must be at most ${MAX_LABEL_NAME} characters`);
    }
    const dup = db
      .prepare('SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND id IS NOT ?')
      .get(clean, exceptId ?? null);
    if (dup) throw new LabelError('duplicate_label', `A label named "${clean}" already exists`);
    return clean;
  }

  function checkColor(color: string): LabelColor {
    if (!(LABEL_COLORS as readonly string[]).includes(color)) throw new LabelError('bad_name', 'Unknown label colour');
    return color as LabelColor;
  }

  function createLabel(name: string, color?: LabelColor): LabelDTO {
    return db.transaction(() => {
      const clean = cleanLabelName(name);
      const stats = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS p FROM labels').get() as Row;
      if (stats.n >= MAX_LABELS) throw new LabelError('too_many_labels', `At most ${MAX_LABELS} labels are allowed`);
      const col = color === undefined ? LABEL_COLORS[stats.n % LABEL_COLORS.length]! : checkColor(color);
      const res = db
        .prepare('INSERT INTO labels (name, color, position, created_at) VALUES (?, ?, ?, ?)')
        .run(clean, col, stats.p + 1, now());
      return getLabel(Number(res.lastInsertRowid))!;
    })();
  }

  function updateLabel(id: number, patch: { name?: string; color?: LabelColor; position?: number }): LabelDTO {
    return db.transaction(() => {
      const cur = getLabel(id);
      if (!cur) throw new LabelError('not_found', `No such label ${id}`);
      const name = patch.name === undefined ? cur.name : cleanLabelName(patch.name, id);
      const color = patch.color === undefined ? cur.color : checkColor(patch.color);
      const position = patch.position ?? cur.position;
      db.prepare('UPDATE labels SET name = ?, color = ?, position = ? WHERE id = ?').run(name, color, position, id);
      return getLabel(id)!;
    })();
  }

  function deleteLabel(id: number): void {
    // item_labels rows go with it (ON DELETE CASCADE).
    if (db.prepare('DELETE FROM labels WHERE id = ?').run(id).changes === 0) {
      throw new LabelError('not_found', `No such label ${id}`);
    }
  }

  function applyLabels(ids: string[], add: number[], remove: number[]): LabelApplyResult {
    return db.transaction(() => {
      const known = new Set((db.prepare('SELECT id FROM labels').all() as Row[]).map((r) => r.id as number));
      const toAdd = [...new Set(add)].filter((l) => known.has(l));
      const toRemove = [...new Set(remove)].filter((l) => known.has(l) && !toAdd.includes(l));
      const exists = db.prepare('SELECT 1 FROM items WHERE id = ?');
      const current = db.prepare('SELECT label_id FROM item_labels WHERE item_id = ? ORDER BY label_id');
      const ins = db.prepare('INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)');
      const del = db.prepare('DELETE FROM item_labels WHERE item_id = ? AND label_id = ?');
      const labels: Record<string, number[]> = {};
      for (const id of new Set(ids)) {
        if (!exists.get(id)) continue;
        let changed = false;
        for (const l of toAdd) changed = ins.run(id, l).changes > 0 || changed;
        for (const l of toRemove) changed = del.run(id, l).changes > 0 || changed;
        if (changed) labels[id] = (current.all(id) as Row[]).map((r) => r.label_id as number);
      }
      return { labels, counts: counts() };
    })();
  }

  /* ---------------- drafts ---------------- */
  function draftDto(r: Row): DraftDTO {
    return { body: r.body, updatedAt: r.updated_at, status: r.status };
  }
  function getDraft(commentId: string): DraftDTO | null {
    const r = db.prepare('SELECT * FROM drafts WHERE item_id = ?').get(commentId) as Row | undefined;
    return r ? draftDto(r) : null;
  }
  function saveDraft(commentId: string, body: string, status: DraftDTO['status']): DraftDTO {
    db.prepare(
      `INSERT INTO drafts (item_id, body, updated_at, status) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
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

  /* ---------------- Google accounts + reply posts ---------------- */
  const accountRow = (r: Row): GoogleAccountRow => ({
    channelId: r.channel_id,
    title: r.channel_title,
    thumbnailUrl: r.channel_thumb,
    refreshToken: r.refresh_token,
    accessToken: r.access_token,
    accessExpiresAt: r.access_expires_at,
    scope: r.scope,
    connectedAt: r.connected_at,
    needsReauth: !!r.needs_reauth,
    lastError: r.last_error,
    isDefault: !!r.is_default,
  });
  const ACCOUNT_COLUMNS: Record<keyof GoogleAccountRow, string> = {
    channelId: 'channel_id',
    title: 'channel_title',
    thumbnailUrl: 'channel_thumb',
    refreshToken: 'refresh_token',
    accessToken: 'access_token',
    accessExpiresAt: 'access_expires_at',
    scope: 'scope',
    connectedAt: 'connected_at',
    needsReauth: 'needs_reauth',
    lastError: 'last_error',
    isDefault: 'is_default',
  };
  const dbVal = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

  function listGoogleAccounts(): GoogleAccountRow[] {
    return (db.prepare('SELECT * FROM google_accounts ORDER BY connected_at, channel_id').all() as Row[]).map(
      accountRow,
    );
  }

  /** Keep exactly one default while any account exists (the earliest-connected wins if none is flagged). */
  function normaliseDefault(preferred?: string): void {
    const rows = db
      .prepare('SELECT channel_id, is_default FROM google_accounts ORDER BY connected_at, channel_id')
      .all() as Row[];
    if (rows.length === 0) return;
    let pick: string | undefined = preferred && rows.some((r) => r.channel_id === preferred) ? preferred : undefined;
    pick ??= (rows.find((r) => r.is_default) ?? rows[0]!).channel_id;
    db.prepare('UPDATE google_accounts SET is_default = (channel_id = ?)').run(pick);
  }

  function upsertGoogleAccount(a: GoogleAccountRow): void {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO google_accounts (channel_id, channel_title, channel_thumb, refresh_token, access_token,
           access_expires_at, scope, connected_at, needs_reauth, last_error, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET channel_title = excluded.channel_title,
           channel_thumb = excluded.channel_thumb, refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
           scope = excluded.scope, connected_at = excluded.connected_at, needs_reauth = excluded.needs_reauth,
           last_error = excluded.last_error,
           is_default = CASE WHEN excluded.is_default = 1 THEN 1 ELSE google_accounts.is_default END`,
      ).run(
        a.channelId,
        a.title,
        a.thumbnailUrl,
        a.refreshToken,
        a.accessToken,
        a.accessExpiresAt,
        a.scope,
        a.connectedAt,
        a.needsReauth ? 1 : 0,
        a.lastError,
        a.isDefault ? 1 : 0,
      );
      // The first account is always the default; an explicit default elsewhere wins over the flag on the others.
      const hasOtherDefault = db
        .prepare('SELECT 1 FROM google_accounts WHERE is_default = 1 AND channel_id != ?')
        .get(a.channelId);
      if (a.isDefault) normaliseDefault(a.channelId);
      else if (!hasOtherDefault) normaliseDefault();
    })();
  }

  function updateGoogleAccount(channelId: string, p: Partial<GoogleAccountRow>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(p) as [keyof GoogleAccountRow, unknown][]) {
      const col = ACCOUNT_COLUMNS[k];
      if (!col || v === undefined || k === 'channelId' || k === 'isDefault') continue;
      sets.push(`${col} = ?`);
      vals.push(dbVal(v));
    }
    db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE google_accounts SET ${sets.join(', ')} WHERE channel_id = ?`).run(...vals, channelId);
      }
      if (p.isDefault === true) normaliseDefault(channelId);
    })();
  }

  function deleteGoogleAccount(channelId: string): void {
    db.transaction(() => {
      db.prepare('DELETE FROM google_accounts WHERE channel_id = ?').run(channelId);
      normaliseDefault();
    })();
  }

  function setDefaultGoogleAccount(channelId: string): void {
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM google_accounts WHERE channel_id = ?').get(channelId)) {
        throw new Error(`Unknown Google account ${channelId}`);
      }
      normaliseDefault(channelId);
    })();
  }

  function beginReplyPost(commentId: string, bodyHash: string): number {
    const res = db
      .prepare("INSERT INTO reply_posts (comment_id, body_hash, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(commentId, bodyHash, now());
    return Number(res.lastInsertRowid);
  }

  function finishReplyPost(
    id: number,
    p: {
      status: 'posted' | 'failed' | 'unknown';
      postedCommentId?: string | null;
      viaChannelId?: string | null;
      error?: string | null;
    },
  ): void {
    db.prepare(
      `UPDATE reply_posts SET status = ?, posted_comment_id = COALESCE(?, posted_comment_id),
         via_channel_id = COALESCE(?, via_channel_id), error = ? WHERE id = ?`,
    ).run(p.status, p.postedCommentId ?? null, p.viaChannelId ?? null, p.error ?? null, id);
  }

  function recentPostedReply(
    commentId: string,
    bodyHash: string,
    sinceIso: string,
  ): { postedCommentId: string } | null {
    const r = db
      .prepare(
        `SELECT posted_comment_id FROM reply_posts
         WHERE comment_id = ? AND body_hash = ? AND status = 'posted' AND posted_comment_id IS NOT NULL
           AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(commentId, bodyHash, iso(sinceIso)) as Row | undefined;
    return r ? { postedCommentId: r.posted_comment_id } : null;
  }

  function isAppPostedReply(commentId: string): boolean {
    return !!db
      .prepare("SELECT 1 FROM reply_posts WHERE posted_comment_id = ? AND status = 'posted' LIMIT 1")
      .get(commentId);
  }

  function recordPostedReply(p: {
    commentId: string;
    body: string;
    posted: YtComment;
    viaChannelId: string;
    replyPostId: number;
  }): { actionId: number; newCommentIds: string[]; changedIds: string[] } {
    return db.transaction(() => {
      const target = db.prepare('SELECT thread_id FROM comments WHERE id = ?').get(p.commentId) as Row | undefined;
      if (!target) throw new Error(`Unknown comment ${p.commentId}`);
      saveDraft(p.commentId, p.body, 'posted');
      // Triage first so the target is a 'user' state that the auto-clear below must not touch.
      const t = triage([p.commentId], 'replied');
      const added = addReplies(target.thread_id, [p.posted]);
      finishReplyPost(p.replyPostId, {
        status: 'posted',
        postedCommentId: p.posted.id,
        viaChannelId: p.viaChannelId,
      });
      const changed = new Set([...t.changes.map((c) => c.commentId), ...added.changedIds]);
      return { actionId: t.actionId, newCommentIds: added.newCommentIds, changedIds: [...changed] };
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

  const todos = createTodosRepo({ db, now });
  const { itemFromRow: _itemFromRow, ...feedMethods } = feeds;

  return {
    ...feedMethods,
    ...todos,
    close: () => void db.close(),
    listGoogleAccounts,
    upsertGoogleAccount,
    updateGoogleAccount,
    deleteGoogleAccount,
    setDefaultGoogleAccount,
    beginReplyPost,
    finishReplyPost,
    recentPostedReply,
    isAppPostedReply,
    recordPostedReply,
    removeLocalComment,
    setThreadCanReply,
    listPushSubscriptions,
    getPushSubscription,
    upsertPushSubscription,
    deletePushSubscription,
    markPushResult,
    getVapidKeys,
    setVapidKeys,
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
    listInbox,
    getThread,
    getComment,
    triage,
    undo,
    snooze,
    undoSnooze,
    wakeSnoozed,
    listLabels,
    createLabel,
    updateLabel,
    deleteLabel,
    applyLabels,
    markHandedOff,
    getDraft,
    putDraft: (commentId, body) => saveDraft(commentId, body, 'draft'),
    deleteDraft: (commentId) => void db.prepare('DELETE FROM drafts WHERE item_id = ?').run(commentId),
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
