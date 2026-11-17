import type { Page, YtChannel, YtComment, YtPlaylist, YtThread, YtVideo } from '../contracts.js';
import { mulberry32 } from '../prng.js';
import {
  AUTHOR_NAMES,
  CRITICISM,
  LINKS,
  LONG,
  OTHER_TITLES,
  OWN_REPLIES,
  OWN_TITLES,
  PRAISE,
  QUESTIONS,
  REACTIONS,
  REPLIES,
  SPAM,
  TOPICS,
} from './text.js';

/** 24 chars so it passes parseSourceInput's UC[\w-]{22} check. */
export const DEMO_OWN_CHANNEL_ID = 'UCdemoOwnChannel00000000';
export const DEMO_OWN_HANDLE = '@demochannel';
export const DEMO_OWN_UPLOADS_ID = 'UUdemoOwnChannel00000000';
export const DEMO_PLAYLIST_A = 'PLdemoPlaylistA000001';
export const DEMO_PLAYLIST_B = 'PLdemoPlaylistB000001';
export const DEMO_STANDALONE_VIDEOS = ['demoStd0001', 'demoStd0002', 'demoStd0003'];
export const DEMO_COMMENTS_DISABLED_VIDEO = 'demoNoComms';
export const DEMO_MISSING_VIDEO = 'demoMissing';

export interface WorldThread {
  id: string;
  videoId: string;
  top: YtComment;
  /** Chronological. */
  replies: YtComment[];
}
export interface WorldVideo {
  meta: YtVideo;
  commentsDisabled: boolean;
  /** Newest top-level comment first (YouTube's order=time). */
  threads: WorldThread[];
}
export interface WorldPlaylist extends YtPlaylist {
  videoIds: string[];
}
export interface DemoWorld {
  readonly seed: number;
  /** The moment the world was generated; all seed timestamps are relative to this. */
  readonly baseNow: Date;
  readonly ownChannelId: string;
  readonly videos: Map<string, WorldVideo>;
  readonly missingVideoIds: Set<string>;
  readonly channels: Map<string, YtChannel>;
  readonly handles: Map<string, string>;
  readonly playlists: Map<string, WorldPlaylist>;
  readonly threadByCommentId: Map<string, WorldThread>;
  /** Own-channel video ids, newest first. */
  readonly ownVideoIds: string[];
  /** Add `n` new comments (top-level, mostly; sometimes replies) to hot videos. Returns how many were added. */
  grow(now: Date, n: number): number;
  /** Someone replies in the thread of this comment (demo "a reply arrives on demand"). Returns the video id, or null. */
  reply(commentId: string, now: Date): string | null;
  totalComments(): number;
}

/* ------------------------------ text rendering ------------------------------ */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Mimic YouTube's textDisplay: escaped, <br> for newlines, linkified URLs and timestamps. */
export function renderHtml(text: string, videoId: string): string {
  return esc(text)
    .replace(/https?:\/\/[^\s<]+/g, (u) => {
      const trail = /[.,;:!?)]+$/.exec(u)?.[0] ?? '';
      const url = u.slice(0, u.length - trail.length);
      return `<a href="${url}">${url}</a>${trail}`;
    })
    .replace(/\[(\d{1,2}):(\d{2})\]/g, (_m, mm: string, ss: string) => {
      const secs = Number(mm) * 60 + Number(ss);
      return `<a href="https://www.youtube.com/watch?v=${videoId}&amp;t=${secs}s">${mm}:${ss}</a>`;
    })
    .replace(/\n/g, '<br>');
}

/* ------------------------------ generation ------------------------------ */
interface Author {
  name: string;
  channelId: string;
  avatar: string;
}

const DAY = 86_400_000;
const MIN = 60_000;

export function createDemoWorld(seed = 42, baseNow: Date = new Date()): DemoWorld {
  const rng = mulberry32(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)] as T;
  const between = (lo: number, hi: number) => lo + rng() * (hi - lo);
  const ibetween = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
  const nowMs = baseNow.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  const authors: Author[] = AUTHOR_NAMES.map((name, i) => ({
    name,
    channelId: `UCdemoViewer${String(i + 1).padStart(12, '0')}`,
    avatar: `https://yt3.ggpht.com/demo/avatar-${i + 1}=s48`,
  }));
  const ownAuthor: Author = {
    name: 'Demo Channel',
    channelId: DEMO_OWN_CHANNEL_ID,
    avatar: 'https://yt3.ggpht.com/demo/avatar-own=s48',
  };

  const channels = new Map<string, YtChannel>();
  const handles = new Map<string, string>();
  const playlists = new Map<string, WorldPlaylist>();
  const videos = new Map<string, WorldVideo>();
  const threadByCommentId = new Map<string, WorldThread>();
  const missingVideoIds = new Set<string>();

  channels.set(DEMO_OWN_CHANNEL_ID, {
    id: DEMO_OWN_CHANNEL_ID,
    title: 'Demo Channel',
    thumbnailUrl: 'https://yt3.ggpht.com/demo/avatar-own=s88',
    uploadsPlaylistId: DEMO_OWN_UPLOADS_ID,
  });
  handles.set(DEMO_OWN_HANDLE, DEMO_OWN_CHANNEL_ID);
  const otherChannels = [
    'Retro Bytes',
    'Compiler Corner',
    'Silicon Stories',
    'The Linker Hour',
    'Low Level Lounge',
  ].map((title, i) => {
    const id = `UCdemoOther${String(i + 1).padStart(13, '0')}`;
    const ch: YtChannel = {
      id,
      title,
      thumbnailUrl: `https://yt3.ggpht.com/demo/chan-${i + 1}=s88`,
      uploadsPlaylistId: null,
    };
    channels.set(id, ch);
    return ch;
  });

  let seq = 0;
  const nextId = (prefix: string) =>
    `${prefix}${(++seq).toString(36).padStart(7, '0')}${Math.floor(rng() * 1e6).toString(36)}`;

  const fill = (tpl: string, durationSec: number) =>
    tpl
      .replace(/\{topic\}/g, () => pick(TOPICS))
      .replace(/\{ts\}/g, () => {
        const s = ibetween(20, Math.max(60, durationSec));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      });

  function mkComment(
    videoId: string,
    id: string,
    parentId: string | null,
    a: Author,
    text: string,
    at: number,
    likes = 0,
  ): YtComment {
    return {
      id,
      parentId,
      videoId,
      authorName: a.name,
      authorChannelId: a.channelId,
      authorAvatarUrl: a.avatar,
      textHtml: renderHtml(text, videoId),
      likeCount: likes,
      publishedAt: iso(at),
      updatedAt: iso(at),
    };
  }

  function topText(durationSec: number): { text: string; question: boolean } {
    const r = rng();
    if (r < 0.28) return { text: fill(pick(QUESTIONS), durationSec), question: true };
    if (r < 0.52) return { text: fill(pick(PRAISE), durationSec), question: false };
    if (r < 0.64) return { text: fill(pick(REACTIONS), durationSec), question: false };
    if (r < 0.72) return { text: fill(pick(LONG), durationSec), question: false };
    if (r < 0.8) return { text: fill(pick(LINKS), durationSec), question: false };
    if (r < 0.9) return { text: fill(pick(CRITICISM), durationSec), question: false };
    if (r < 0.93) return { text: pick(SPAM), question: false };
    return { text: `${fill(pick(PRAISE), durationSec)}\n\n${fill(pick(QUESTIONS), durationSec)}`, question: true };
  }

  const replyText = (to: Author | null, durationSec: number) => {
    const body = rng() < 0.2 ? fill(pick(PRAISE), durationSec) : pick(REPLIES);
    return to && rng() < 0.45 ? `@${to.name} ${body}` : body;
  };
  // Mentions in YouTube HTML are links to the author's channel.
  const mentionHtml = (html: string, to: Author | null) =>
    to && html.startsWith(`@${esc(to.name)} `)
      ? html.replace(
          `@${esc(to.name)}`,
          `<a href="https://www.youtube.com/channel/${to.channelId}">@${esc(to.name)}</a>`,
        )
      : html;

  function insertThread(v: WorldVideo, t: WorldThread): void {
    // keep newest-first by top-level time (stable for equal stamps)
    let i = 0;
    while (i < v.threads.length && (v.threads[i] as WorldThread).top.publishedAt > t.top.publishedAt) i++;
    v.threads.splice(i, 0, t);
    threadByCommentId.set(t.id, t);
    for (const r of t.replies) threadByCommentId.set(r.id, t);
  }

  function addVideo(meta: YtVideo, commentsDisabled: boolean): WorldVideo {
    const v: WorldVideo = { meta, commentsDisabled, threads: [] };
    videos.set(meta.id, v);
    return v;
  }

  /** Comment age: skewed towards recent, never older than the video. */
  const sampleAge = (maxAgeMs: number) => Math.max(2 * MIN, maxAgeMs * Math.pow(rng(), 2.6));

  function populate(v: WorldVideo, threadCount: number, own: boolean, longThreads: number): void {
    const vid = v.meta.id;
    const videoAge = nowMs - new Date(v.meta.publishedAt as string).getTime();
    const duration = ibetween(240, 1500);
    for (let i = 0; i < threadCount; i++) {
      const author = pick(authors);
      const { text, question } = topText(duration);
      const topAt = nowMs - sampleAge(videoAge - 5 * MIN);
      const top = mkComment(vid, nextId('Ugz'), null, author, text, topAt, rng() < 0.3 ? ibetween(1, 60) : 0);
      const replies: YtComment[] = [];
      const longThread = i < longThreads;
      const r = rng();
      const count = longThread
        ? ibetween(12, 26)
        : r < 0.68
          ? 0
          : r < 0.88
            ? ibetween(1, 3)
            : r < 0.97
              ? ibetween(4, 8)
              : ibetween(9, 12);
      let at = topAt;
      const participants = [author, pick(authors), pick(authors), pick(authors)];
      for (let k = 0; k < count; k++) {
        at = Math.min(nowMs - MIN, at + between(2 * MIN, Math.min(2 * DAY, Math.max(5 * MIN, (nowMs - at) * 0.5))));
        const who = k % 2 === 0 ? pick(participants.slice(1)) : author;
        const prev = k === 0 ? author : (participants[(k + 1) % participants.length] ?? author);
        const plain = replyText(prev, duration);
        const c = mkComment(
          vid,
          `${top.id}.${nextId('Ugr')}`,
          top.id,
          who,
          plain,
          at,
          rng() < 0.15 ? ibetween(1, 12) : 0,
        );
        c.textHtml = mentionHtml(c.textHtml, prev);
        replies.push(c);
      }
      // The channel owner answers questions (and long threads) on their own videos, sometimes mid-thread.
      if (
        own &&
        author.channelId !== DEMO_OWN_CHANNEL_ID &&
        ((question && rng() < 0.55) || longThread || rng() < 0.12)
      ) {
        const ownAt = Math.min(nowMs - MIN, topAt + between(30 * MIN, 2 * DAY));
        const text2 = pick(OWN_REPLIES);
        const c = mkComment(vid, `${top.id}.${nextId('Ugo')}`, top.id, ownAuthor, text2, ownAt, ibetween(0, 20));
        const idx = replies.findIndex((x) => x.publishedAt > c.publishedAt);
        if (idx < 0) replies.push(c);
        else replies.splice(idx, 0, c);
      }
      insertThread(v, { id: top.id, videoId: vid, top, replies });
    }
  }

  const stats = (ageDays: number, own: boolean) => ({
    // Derived from the age, not rng(), so adding stats does not reshuffle the seeded demo world.
    durationSeconds: Math.round(180 + ((ageDays * 7919) % 1500) * (own ? 1.4 : 2)),
    likeCount: Math.round(40 + ((ageDays * 104729) % 900) * (own ? 4 : 1.5)),
    viewCount: Math.round(((own ? 40_000 : 15_000) * (0.4 + rng() * 2) * Math.min(ageDays + 5, 120)) / 10),
  });

  /* ---- own channel: 30 videos from ~7 hours to ~2 years old ---- */
  const ownAges = [
    0.3, 0.9, 1.6, 2.4, 4, 6, 8, 11, 14, 19, 24, 29, 38, 52, 70, 95, 130, 170, 220, 280, 330, 380, 440, 500, 560, 610,
    650, 690, 720, 740,
  ];
  const ownVideoIds: string[] = [];
  OWN_TITLES.forEach((title, i) => {
    const id = i === 29 ? DEMO_COMMENTS_DISABLED_VIDEO : `demoOwn${String(i + 1).padStart(4, '0')}`;
    const age = ownAges[i] as number;
    const meta: YtVideo = {
      id,
      title,
      channelId: DEMO_OWN_CHANNEL_ID,
      channelTitle: 'Demo Channel',
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      publishedAt: iso(nowMs - age * DAY),
      ...stats(age, true),
      commentCount: null,
    };
    // the comments-disabled video is the Q&A at index 28/29: put it at a realistic age
    const v = addVideo(meta, id === DEMO_COMMENTS_DISABLED_VIDEO);
    ownVideoIds.push(id);
    if (!v.commentsDisabled) {
      const n = age < 3 ? ibetween(14, 22) : age < 30 ? ibetween(10, 16) : age < 365 ? ibetween(6, 12) : ibetween(3, 8);
      populate(v, n, true, i === 3 || i === 7 ? 2 : i === 12 ? 1 : 0);
    }
  });
  playlists.set(DEMO_OWN_UPLOADS_ID, {
    id: DEMO_OWN_UPLOADS_ID,
    title: 'Uploads',
    thumbnailUrl: null,
    channelId: DEMO_OWN_CHANNEL_ID,
    videoIds: [...ownVideoIds],
  });

  /* ---- third-party videos ---- */
  const thirdParty = (prefix: string, count: number, titles: string[], maxAge: number, perVideo: [number, number]) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${prefix}${String(i + 1).padStart(4, '0')}`;
      const age = i < 2 ? between(0.5, 2.5) : between(3, maxAge);
      const ch = pick(otherChannels);
      const meta: YtVideo = {
        id,
        title: titles[i % titles.length] as string,
        channelId: ch.id,
        channelTitle: ch.title,
        thumbnailUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        publishedAt: iso(nowMs - age * DAY),
        ...stats(age, false),
        commentCount: null,
      };
      populate(addVideo(meta, false), ibetween(perVideo[0], perVideo[1]), false, 0);
      ids.push(id);
    }
    return ids;
  };
  const plA = thirdParty('demoPlA', 12, OTHER_TITLES.slice(0, 12), 500, [8, 16]);
  const plB = thirdParty('demoPlB', 10, OTHER_TITLES.slice(12, 22), 300, [6, 14]);
  const std = thirdParty('demoStd', 3, OTHER_TITLES.slice(21), 40, [10, 18]);
  // One playlist entry that the API will not return (private/deleted).
  missingVideoIds.add(DEMO_MISSING_VIDEO);
  playlists.set(DEMO_PLAYLIST_A, {
    id: DEMO_PLAYLIST_A,
    title: 'Retro computing favourites',
    thumbnailUrl: 'https://i.ytimg.com/vi/demoPlA0001/mqdefault.jpg',
    channelId: null,
    videoIds: [...plA.slice(0, 6), DEMO_MISSING_VIDEO, ...plA.slice(6)],
  });
  playlists.set(DEMO_PLAYLIST_B, {
    id: DEMO_PLAYLIST_B,
    title: 'Compiler talks worth watching',
    thumbnailUrl: 'https://i.ytimg.com/vi/demoPlB0001/mqdefault.jpg',
    channelId: null,
    videoIds: plB,
  });
  void std;

  // Fill in comment counts now that threads exist.
  for (const v of videos.values()) {
    v.meta.commentCount = v.commentsDisabled ? null : v.threads.reduce((n, t) => n + 1 + t.replies.length, 0);
  }

  let lastStamp = nowMs;
  const world: DemoWorld = {
    seed,
    baseNow,
    ownChannelId: DEMO_OWN_CHANNEL_ID,
    videos,
    missingVideoIds,
    channels,
    handles,
    playlists,
    threadByCommentId,
    ownVideoIds,
    totalComments() {
      let n = 0;
      for (const v of videos.values()) for (const t of v.threads) n += 1 + t.replies.length;
      return n;
    },
    grow(now, n) {
      const hot = [...videos.values()].filter(
        (v) => !v.commentsDisabled && now.getTime() - new Date(v.meta.publishedAt as string).getTime() < 3 * DAY,
      );
      if (!hot.length) return 0;
      for (let i = 0; i < n; i++) {
        const v = pick(hot);
        // strictly increasing stamps so ordering and ids stay deterministic even with a frozen clock
        lastStamp = Math.max(lastStamp + 1000, now.getTime());
        const at = lastStamp;
        const vid = v.meta.id;
        const recent = v.threads.slice(0, 5);
        if (recent.length && rng() < 0.35) {
          const t = pick(recent);
          const c = mkComment(
            vid,
            `${t.id}.${nextId('Ugr')}`,
            t.id,
            pick(authors),
            replyText(t.top.authorName ? pick(authors) : null, 600),
            at,
          );
          t.replies.push(c);
          threadByCommentId.set(c.id, t);
        } else {
          const { text } = topText(600);
          const top = mkComment(vid, nextId('Ugz'), null, pick(authors), text, at);
          insertThread(v, { id: top.id, videoId: vid, top, replies: [] });
        }
        if (v.meta.commentCount !== null) v.meta.commentCount++;
      }
      return n;
    },
    reply(commentId, now) {
      const t = threadByCommentId.get(commentId);
      if (!t) return null;
      lastStamp = Math.max(lastStamp + 1000, now.getTime());
      const c = mkComment(t.videoId, `${t.id}.${nextId('Ugr')}`, t.id, pick(authors), replyText(null, 600), lastStamp);
      t.replies.push(c);
      threadByCommentId.set(c.id, t);
      const v = videos.get(t.videoId);
      if (v && v.meta.commentCount !== null) v.meta.commentCount++;
      return t.videoId;
    },
  };
  return world;
}

/** Alias used by server/index.ts. */
export const createWorld = createDemoWorld;

/* ------------------------------ API-shaped views ------------------------------ */
export const THREAD_PAGE = 100;
export const INLINE_REPLIES = 5;

export function toYtThread(t: WorldThread, channelId: string | null): YtThread {
  return {
    id: t.id,
    videoId: t.videoId,
    channelId,
    canReply: true,
    topComment: t.top,
    totalReplyCount: t.replies.length,
    replies: t.replies.slice(0, INLINE_REPLIES),
  };
}

export function paginate<T>(all: T[], pageToken: string | undefined, size: number): Page<T> {
  const start = pageToken ? Number(pageToken.replace(/^p/, '')) || 0 : 0;
  const end = start + size;
  return { items: all.slice(start, end), nextPageToken: end < all.length ? `p${end}` : null };
}
