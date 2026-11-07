import { YtError, type QuotaTracker, type YouTubeClient } from '../contracts.js';
import { INLINE_REPLIES, THREAD_PAGE, paginate, toYtThread, type DemoWorld, type WorldThread } from './world.js';

export interface FakeClientOptions {
  /** Live mode: calls occasionally make new comments appear on hot videos. */
  live: boolean;
  now?: () => Date;
  /** Optional: charge the quota meter as the real client would, so the demo UI looks alive. */
  quota?: QuotaTracker;
  /** Minimum ms between automatic growth bursts in live mode (default 15s). */
  growEveryMs?: number;
}

export type FakeClient = YouTubeClient & { tick(): void };

export function createFakeClient(world: DemoWorld, opts: FakeClientOptions): FakeClient {
  const now = opts.now ?? (() => new Date());
  const growEvery = opts.growEveryMs ?? 15_000;
  let lastGrow = now().getTime();
  const charge = (endpoint: string) => opts.quota?.charge(endpoint, 1);

  const maybeGrow = () => {
    if (!opts.live) return;
    const t = now().getTime();
    if (t - lastGrow < growEvery) return;
    lastGrow = t;
    world.grow(now(), Math.floor(Math.random() * 4)); // 0-3 new comments
  };

  return {
    tick() {
      world.grow(now(), 1 + Math.floor(Math.random() * 3));
    },

    async listCommentThreads(p) {
      charge('commentThreads');
      maybeGrow();
      if (p.videoId) {
        if (world.missingVideoIds.has(p.videoId) || !world.videos.has(p.videoId))
          throw new YtError('notFound', `Video ${p.videoId} not found`, 404);
        const v = world.videos.get(p.videoId)!;
        if (v.commentsDisabled) throw new YtError('commentsDisabled', 'Comments are disabled for this video', 403);
        return paginate(
          v.threads.map((t) => toYtThread(t, v.meta.channelId)),
          p.pageToken,
          THREAD_PAGE,
        );
      }
      if (p.allThreadsRelatedToChannelId) {
        const threads: { t: WorldThread; channelId: string | null }[] = [];
        for (const v of world.videos.values()) {
          if (v.meta.channelId !== p.allThreadsRelatedToChannelId || v.commentsDisabled) continue;
          for (const t of v.threads) threads.push({ t, channelId: v.meta.channelId });
        }
        threads.sort((a, b) =>
          a.t.top.publishedAt < b.t.top.publishedAt ? 1 : a.t.top.publishedAt > b.t.top.publishedAt ? -1 : 0,
        );
        return paginate(
          threads.map((x) => toYtThread(x.t, x.channelId)),
          p.pageToken,
          THREAD_PAGE,
        );
      }
      throw new YtError('badRequest', 'videoId or allThreadsRelatedToChannelId required', 400);
    },

    async listReplies(p) {
      charge('comments');
      const t = world.threadByCommentId.get(p.parentId);
      if (!t || t.id !== p.parentId) throw new YtError('notFound', 'Comment not found', 404);
      return paginate(t.replies, p.pageToken, THREAD_PAGE);
    },

    async listPlaylistItems(p) {
      charge('playlistItems');
      const pl = world.playlists.get(p.playlistId);
      if (!pl) throw new YtError('notFound', 'Playlist not found', 404);
      const all = pl.videoIds.map((videoId, position) => ({ videoId, position }));
      return paginate(all, p.pageToken, 50);
    },

    async getVideos(ids) {
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += 50) charge('videos');
      if (!unique.length) return [];
      return unique.flatMap((id) => {
        const v = world.videos.get(id);
        return v && !world.missingVideoIds.has(id) ? [{ ...v.meta }] : [];
      });
    },

    async getChannel(p) {
      charge('channels');
      const id = p.id ?? world.handles.get(normaliseHandle(p.handle ?? ''));
      return (id && world.channels.get(id)) || null;
    },

    async getPlaylist(id) {
      charge('playlists');
      const pl = world.playlists.get(id);
      return pl ? { id: pl.id, title: pl.title, thumbnailUrl: pl.thumbnailUrl, channelId: pl.channelId } : null;
    },
  };
}

const normaliseHandle = (h: string) => (h.startsWith('@') ? h : `@${h}`).toLowerCase();
export { INLINE_REPLIES };
