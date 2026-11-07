import {
  YtError,
  type Page,
  type QuotaTracker,
  type YouTubeClient,
  type YtChannel,
  type YtComment,
  type YtPlaylist,
  type YtThread,
  type YtVideo,
} from '../contracts.js';
import { isRetryable, mapApiError } from './errors.js';

export const API_BASE = 'https://www.googleapis.com/youtube/v3';
const RETRY_DELAYS_MS = [1000, 2000, 4000];

export interface HttpClientOptions {
  getApiKey: () => string | null;
  quota: QuotaTracker;
  fetchImpl?: typeof fetch;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxConcurrency?: number;
}

/* ---- raw response shapes (only the fields we ask for) ---- */
interface RawComment {
  id: string;
  snippet?: {
    authorDisplayName?: string;
    authorProfileImageUrl?: string;
    authorChannelId?: { value?: string };
    textDisplay?: string;
    likeCount?: number;
    publishedAt?: string;
    updatedAt?: string;
    parentId?: string;
    videoId?: string;
  };
}
interface RawThread {
  id: string;
  snippet?: {
    videoId?: string;
    channelId?: string;
    canReply?: boolean;
    totalReplyCount?: number;
    topLevelComment?: RawComment;
  };
  replies?: { comments?: RawComment[] };
}
interface RawThumbs {
  medium?: { url?: string };
  default?: { url?: string };
  high?: { url?: string };
}
interface RawList<T> {
  items?: T[];
  nextPageToken?: string;
}

const COMMENT_SNIPPET =
  'authorDisplayName,authorProfileImageUrl,authorChannelId,textDisplay,likeCount,publishedAt,updatedAt,videoId';
const THREAD_FIELDS =
  `nextPageToken,items(id,snippet(videoId,channelId,canReply,totalReplyCount,topLevelComment(id,snippet(${COMMENT_SNIPPET}))),` +
  `replies(comments(id,snippet(${COMMENT_SNIPPET},parentId))))`;
const REPLY_FIELDS = `nextPageToken,items(id,snippet(${COMMENT_SNIPPET},parentId))`;
/** ISO 8601 duration as YouTube sends it (PT1H2M3S, P1DT2H); null for missing/live/garbage. */
export function parseIsoDuration(d: string | undefined): number | null {
  const m = d ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d) : null;
  if (!m || d === 'P' || d === 'PT') return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

const THUMB = 'thumbnails(default(url),medium(url),high(url))';

const thumb = (t?: RawThumbs): string | null => t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null;

export function normComment(c: RawComment, videoId: string, parentId: string | null): YtComment {
  const s = c.snippet ?? {};
  const published = s.publishedAt ?? new Date(0).toISOString();
  return {
    id: c.id,
    parentId: s.parentId ?? parentId,
    videoId: s.videoId ?? videoId,
    authorName: s.authorDisplayName ?? 'Unknown',
    authorChannelId: s.authorChannelId?.value ?? null,
    authorAvatarUrl: s.authorProfileImageUrl ?? null,
    textHtml: s.textDisplay ?? '',
    likeCount: s.likeCount ?? 0,
    publishedAt: published,
    updatedAt: s.updatedAt ?? published,
  };
}

function normThread(t: RawThread): YtThread {
  const s = t.snippet ?? {};
  const videoId = s.videoId ?? '';
  const top = normComment(t.snippet?.topLevelComment ?? { id: t.id }, videoId, null);
  const replies = (t.replies?.comments ?? []).map((r) => normComment(r, videoId, t.id));
  return {
    id: t.id,
    videoId,
    channelId: s.channelId ?? null,
    canReply: s.canReply ?? true,
    topComment: { ...top, videoId },
    totalReplyCount: s.totalReplyCount ?? replies.length,
    replies,
  };
}

class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next)
      next(); // hand the slot straight over
    else this.active--;
  }
}

export function createHttpClient(opts: HttpClientOptions): YouTubeClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const sem = new Semaphore(opts.maxConcurrency ?? 4);

  async function call<T>(endpoint: string, params: Record<string, string | undefined>): Promise<T> {
    const key = opts.getApiKey()?.trim();
    if (!key) throw new YtError('keyInvalid', 'No YouTube API key configured');
    const url = new URL(`${API_BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    url.searchParams.set('key', key);

    opts.quota.charge(endpoint, 1); // every list call costs 1 unit
    await sem.acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const delay = RETRY_DELAYS_MS[attempt];
        let res: Response;
        try {
          res = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
        } catch (e) {
          if (delay === undefined) {
            const msg = (e instanceof Error ? e.message : String(e)).split(key).join('***');
            throw new YtError('network', `Network error: ${msg}`);
          }
          await sleep(delay + random() * 250);
          continue;
        }
        const text = await res.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          /* non-JSON error page */
        }
        if (res.ok) return (body ?? {}) as T;
        if (delay !== undefined && isRetryable(res.status, body)) {
          await sleep(delay + random() * 250);
          continue;
        }
        throw mapApiError(res.status, body);
      }
    } finally {
      sem.release();
    }
  }

  return {
    async listCommentThreads(p) {
      const raw = await call<RawList<RawThread>>('commentThreads', {
        part: 'snippet,replies',
        videoId: p.videoId,
        allThreadsRelatedToChannelId: p.videoId ? undefined : p.allThreadsRelatedToChannelId,
        maxResults: '100',
        order: 'time',
        textFormat: 'html',
        pageToken: p.pageToken,
        fields: THREAD_FIELDS,
      });
      return { items: (raw.items ?? []).map(normThread), nextPageToken: raw.nextPageToken ?? null };
    },

    async listReplies(p): Promise<Page<YtComment>> {
      const raw = await call<RawList<RawComment>>('comments', {
        part: 'snippet',
        parentId: p.parentId,
        maxResults: '100',
        textFormat: 'html',
        pageToken: p.pageToken,
        fields: REPLY_FIELDS,
      });
      return {
        items: (raw.items ?? []).map((c) => normComment(c, '', p.parentId)),
        nextPageToken: raw.nextPageToken ?? null,
      };
    },

    async listPlaylistItems(p) {
      const raw = await call<RawList<{ snippet?: { position?: number; resourceId?: { videoId?: string } } }>>(
        'playlistItems',
        {
          part: 'snippet',
          playlistId: p.playlistId,
          maxResults: '50',
          pageToken: p.pageToken,
          fields: 'nextPageToken,items(snippet(position,resourceId(videoId)))',
        },
      );
      const items: { videoId: string; position: number }[] = [];
      for (const it of raw.items ?? []) {
        const videoId = it.snippet?.resourceId?.videoId;
        if (videoId) items.push({ videoId, position: it.snippet?.position ?? items.length });
      }
      return { items, nextPageToken: raw.nextPageToken ?? null };
    },

    async getVideos(ids) {
      const unique = [...new Set(ids)];
      const out: YtVideo[] = [];
      for (let i = 0; i < unique.length; i += 50) {
        const raw = await call<
          RawList<{
            id: string;
            snippet?: {
              title?: string;
              channelId?: string;
              channelTitle?: string;
              publishedAt?: string;
              thumbnails?: RawThumbs;
            };
            statistics?: { viewCount?: string; commentCount?: string; likeCount?: string };
            contentDetails?: { duration?: string };
          }>
        >('videos', {
          part: 'snippet,statistics,contentDetails',
          id: unique.slice(i, i + 50).join(','),
          maxResults: '50',
          fields: `items(id,snippet(title,channelId,channelTitle,publishedAt,${THUMB}),statistics(viewCount,commentCount,likeCount),contentDetails(duration))`,
        });
        for (const v of raw.items ?? []) {
          const num = (s?: string) => (s === undefined ? null : Number(s));
          out.push({
            id: v.id,
            title: v.snippet?.title ?? '',
            channelId: v.snippet?.channelId ?? null,
            channelTitle: v.snippet?.channelTitle ?? null,
            thumbnailUrl: thumb(v.snippet?.thumbnails),
            publishedAt: v.snippet?.publishedAt ?? null,
            viewCount: num(v.statistics?.viewCount),
            commentCount: num(v.statistics?.commentCount),
            likeCount: num(v.statistics?.likeCount),
            durationSeconds: parseIsoDuration(v.contentDetails?.duration),
          });
        }
      }
      return out;
    },

    async getChannel(p): Promise<YtChannel | null> {
      const raw = await call<
        RawList<{
          id: string;
          snippet?: { title?: string; thumbnails?: RawThumbs };
          contentDetails?: { relatedPlaylists?: { uploads?: string } };
        }>
      >('channels', {
        part: 'snippet,contentDetails',
        id: p.id,
        forHandle: p.id ? undefined : p.handle,
        fields: `items(id,snippet(title,${THUMB}),contentDetails(relatedPlaylists(uploads)))`,
      });
      const c = raw.items?.[0];
      if (!c) return null;
      return {
        id: c.id,
        title: c.snippet?.title ?? '',
        thumbnailUrl: thumb(c.snippet?.thumbnails),
        uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads ?? null,
      };
    },

    async getPlaylist(id): Promise<YtPlaylist | null> {
      const raw = await call<
        RawList<{ id: string; snippet?: { title?: string; channelId?: string; thumbnails?: RawThumbs } }>
      >('playlists', { part: 'snippet', id, fields: `items(id,snippet(title,channelId,${THUMB}))` });
      const p = raw.items?.[0];
      if (!p) return null;
      return {
        id: p.id,
        title: p.snippet?.title ?? '',
        thumbnailUrl: thumb(p.snippet?.thumbnails),
        channelId: p.snippet?.channelId ?? null,
      };
    },
  };
}

/** Validate a key with a 1-unit videos.list call. Never throws. */
export async function testKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: 'No API key provided' };
  const url = `${API_BASE}/videos?part=id&id=jNQXAC9IVRw&fields=items(id)&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchImpl(url);
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return { ok: true, message: 'API key works' };
    const err = mapApiError(res.status, body);
    if (err.reason === 'quotaExceeded') return { ok: true, message: 'Key is valid but today’s quota is used up' };
    return { ok: false, message: err.message };
  } catch (e) {
    return {
      ok: false,
      message: `Network error: ${(e instanceof Error ? e.message : String(e)).split(key).join('***')}`,
    };
  }
}
