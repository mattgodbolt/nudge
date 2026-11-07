// Shared fixtures for engine/scheduler/sources tests (real in-memory Repo, scripted YouTube client).
import { createRepo } from '../db/repo.js';
import { openDb } from '../db/db.js';
import {
  YtError,
  type EventBus,
  type Page,
  type Repo,
  type YouTubeClient,
  type YtComment,
  type YtThread,
  type YtVideo,
} from '../contracts.js';
import type { ServerEvent } from '../../shared/types.js';
import { createQuotaTracker } from './quota.js';
import { createSyncEngine } from './engine.js';

export const T0 = new Date('2026-03-10T12:00:00.000Z');
export const OWN = 'UCtestOwn0000000000000000';

export function makeClock(start = T0) {
  let ms = start.getTime();
  return {
    now: () => new Date(ms),
    advance: (msDelta: number) => {
      ms += msDelta;
    },
  };
}

export function makeBus(): EventBus & {
  events: ServerEvent[];
  of<T extends ServerEvent['type']>(t: T): Extract<ServerEvent, { type: T }>[];
} {
  const subs = new Set<(e: ServerEvent) => void>();
  const events: ServerEvent[] = [];
  return {
    events,
    emit(e) {
      events.push(e);
      subs.forEach((f) => f(e));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    of: (t) => events.filter((e) => e.type === t) as never,
  };
}

export function comment(id: string, videoId: string, at: Date, o: Partial<YtComment> = {}): YtComment {
  return {
    id,
    parentId: null,
    videoId,
    authorName: `Author ${id}`,
    authorChannelId: `UCviewer_${id}`,
    authorAvatarUrl: null,
    textHtml: `text of ${id}`,
    likeCount: 0,
    publishedAt: at.toISOString(),
    updatedAt: at.toISOString(),
    ...o,
  };
}

export function thread(
  id: string,
  videoId: string,
  at: Date,
  replies: YtComment[] = [],
  inline = 5,
  o: Partial<YtThread> = {},
): YtThread {
  return {
    id,
    videoId,
    channelId: 'UCchan',
    canReply: true,
    topComment: comment(id, videoId, at),
    totalReplyCount: replies.length,
    replies: replies.slice(0, inline).map((r) => ({ ...r, parentId: id })),
    ...o,
  };
}

/** Scriptable client: mutate `threads`/`videos` between runs, inspect `calls`. */
export class StubClient implements YouTubeClient {
  threads = new Map<string, YtThread[]>(); // by videoId, newest first
  replies = new Map<string, YtComment[]>(); // by thread id
  videos = new Map<string, YtVideo>();
  playlists = new Map<string, string[]>();
  channels = new Map<
    string,
    { id: string; title: string; thumbnailUrl: string | null; uploadsPlaylistId: string | null }
  >();
  handles = new Map<string, string>();
  errors = new Map<string, YtError>(); // by videoId, for commentThreads
  calls: string[] = [];
  pageSize = 100;
  gate: Promise<void> | null = null;

  private page<T>(all: T[], token?: string, size = this.pageSize): Page<T> {
    const start = token ? Number(token) : 0;
    const end = start + size;
    return { items: all.slice(start, end), nextPageToken: end < all.length ? String(end) : null };
  }
  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
  async listCommentThreads(p: { videoId?: string; allThreadsRelatedToChannelId?: string; pageToken?: string }) {
    this.calls.push(`threads:${p.videoId ?? 'feed:' + p.allThreadsRelatedToChannelId}:${p.pageToken ?? ''}`);
    if (this.gate) await this.gate;
    if (p.videoId) {
      const err = this.errors.get(p.videoId);
      if (err) throw err;
      return this.page(this.threads.get(p.videoId) ?? [], p.pageToken);
    }
    const all = [...this.threads.values()]
      .flat()
      .sort((a, b) => b.topComment.publishedAt.localeCompare(a.topComment.publishedAt));
    return this.page(all, p.pageToken);
  }
  async listReplies(p: { parentId: string; pageToken?: string }) {
    this.calls.push(`replies:${p.parentId}:${p.pageToken ?? ''}`);
    return this.page(this.replies.get(p.parentId) ?? [], p.pageToken);
  }
  async listPlaylistItems(p: { playlistId: string; pageToken?: string }) {
    this.calls.push(`playlistItems:${p.playlistId}:${p.pageToken ?? ''}`);
    const ids = this.playlists.get(p.playlistId) ?? [];
    return this.page(
      ids.map((videoId, position) => ({ videoId, position })),
      p.pageToken,
      50,
    );
  }
  async getVideos(ids: string[]) {
    this.calls.push(`videos:${ids.join(',')}`);
    return ids.flatMap((id) => (this.videos.has(id) ? [this.videos.get(id) as YtVideo] : []));
  }
  async getChannel(p: { id?: string; handle?: string }) {
    this.calls.push(`channel:${p.id ?? p.handle}`);
    const id = p.id ?? this.handles.get(p.handle ?? '');
    return (id && this.channels.get(id)) || null;
  }
  async getPlaylist(id: string) {
    this.calls.push(`playlist:${id}`);
    return this.playlists.has(id) ? { id, title: `Playlist ${id}`, thumbnailUrl: null, channelId: null } : null;
  }
}

export function ytVideo(id: string, publishedAt: Date, o: Partial<YtVideo> = {}): YtVideo {
  return {
    id,
    title: `Video ${id}`,
    channelId: 'UCchan',
    channelTitle: 'Chan',
    thumbnailUrl: null,
    publishedAt: publishedAt.toISOString(),
    viewCount: 100,
    commentCount: 10,
    ...o,
  };
}

export function makeEnv(opts: { settings?: Partial<Parameters<Repo['updateSettings']>[0]> } = {}) {
  const clock = makeClock();
  const repo = createRepo(openDb(':memory:'), clock.now);
  repo.updateSettings({ ownChannelIds: [OWN], ...opts.settings });
  const yt = new StubClient();
  const bus = makeBus();
  const quota = createQuotaTracker({ repo, getSettings: () => repo.getSettings(), clock: clock.now });
  const engine = createSyncEngine({ repo, yt, quota, bus, clock: clock.now });

  /** Add a video source (kind=video) with the video published `ageDays` ago. */
  function addVideo(id: string, ageDays: number, importMode: 'none' | 'recent' | 'all' = 'all') {
    const published = new Date(clock.now().getTime() - ageDays * 86_400_000);
    yt.videos.set(id, ytVideo(id, published));
    const src = repo.addSource({ kind: 'video', ytId: id, title: id, thumbnailUrl: null, isOwn: false, importMode });
    repo.setSourceVideos(src.id, [{ id, position: 0 }]);
    repo.upsertVideos([ytVideo(id, published)]);
    return src;
  }
  return { clock, repo, yt, bus, quota, engine, addVideo };
}
