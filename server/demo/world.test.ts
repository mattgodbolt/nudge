import { describe, expect, it } from 'vitest';
import { createRepo } from '../db/repo.js';
import { openDb } from '../db/db.js';
import { parseSourceInput } from '../../shared/youtube-urls.js';
import { createFakeClient } from './fake-client.js';
import { seedDemo } from './seed.js';
import {
  DEMO_COMMENTS_DISABLED_VIDEO,
  DEMO_MISSING_VIDEO,
  DEMO_OWN_CHANNEL_ID,
  DEMO_PLAYLIST_A,
  DEMO_PLAYLIST_B,
  DEMO_STANDALONE_VIDEOS,
  createDemoWorld,
} from './world.js';
import { createSyncEngine } from '../sync/engine.js';
import { createQuotaTracker } from '../sync/quota.js';
import { createAddSource } from '../sync/sources.js';
import { makeBus } from '../sync/test-helpers.js';
import { YtError } from '../contracts.js';

const NOW = new Date('2026-06-01T12:00:00Z');

describe('demo ids', () => {
  it('are accepted by parseSourceInput', () => {
    expect(parseSourceInput(DEMO_OWN_CHANNEL_ID)).toEqual({ kind: 'channel', ytId: DEMO_OWN_CHANNEL_ID });
    expect(parseSourceInput(DEMO_PLAYLIST_A)?.kind).toBe('playlist');
    expect(parseSourceInput(DEMO_PLAYLIST_B)?.kind).toBe('playlist');
    for (const v of DEMO_STANDALONE_VIDEOS) expect(parseSourceInput(v)?.kind).toBe('video');
  });
});

describe('demo world', () => {
  const world = createDemoWorld(42, NOW);

  it('is deterministic for a seed and varies with another', () => {
    const again = createDemoWorld(42, NOW);
    const ids = (w: typeof world) => [...w.videos.values()].flatMap((v) => v.threads.map((t) => t.id));
    expect(ids(again)).toEqual(ids(world));
    expect(ids(createDemoWorld(7, NOW))).not.toEqual(ids(world));
  });

  it('has the planned shape', () => {
    expect(world.ownVideoIds).toHaveLength(30);
    expect(world.playlists.get(DEMO_PLAYLIST_A)?.videoIds).toContain(DEMO_MISSING_VIDEO);
    expect(world.videos.get(DEMO_COMMENTS_DISABLED_VIDEO)?.commentsDisabled).toBe(true);
    expect(world.videos.has(DEMO_MISSING_VIDEO)).toBe(false);
    expect(world.totalComments()).toBeGreaterThan(1200);
    expect(world.totalComments()).toBeLessThan(2500);
  });

  it('has varied, realistic content', () => {
    const all = [...world.videos.values()].flatMap((v) => v.threads.flatMap((t) => [t.top, ...t.replies]));
    const html = all.map((c) => c.textHtml);
    expect(html.some((h) => h.includes('<br>'))).toBe(true);
    expect(
      html.some((h) => /<a href="https:\/\/www\.youtube\.com\/watch\?v=[\w-]+&amp;t=\d+s">\d+:\d{2}<\/a>/.test(h)),
    ).toBe(true);
    expect(html.some((h) => /<a href="https?:\/\/[^"]+">/.test(h) && !h.includes('youtube.com/watch'))).toBe(true);
    expect(html.some((h) => /\p{Extended_Pictographic}/u.test(h))).toBe(true);
    expect(html.some((h) => h.length > 400)).toBe(true);
    expect(html.some((h) => h.includes('?'))).toBe(true);
    expect(new Set(html).size).toBeGreaterThan(100);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    // threads with 12+ replies exist
    const big = [...world.videos.values()].flatMap((v) => v.threads).filter((t) => t.replies.length >= 12);
    expect(big.length).toBeGreaterThanOrEqual(3);
    // some threads already answered by the own channel
    const answered = [...world.videos.values()]
      .flatMap((v) => v.threads)
      .filter((t) => t.replies.some((r) => r.authorChannelId === DEMO_OWN_CHANNEL_ID));
    expect(answered.length).toBeGreaterThan(20);
  });

  it('is fresh relative to now: minutes to weeks old, nothing in the future', () => {
    const times = [...world.videos.values()]
      .flatMap((v) => v.threads.flatMap((t) => [t.top, ...t.replies]))
      .map((c) => NOW.getTime() - Date.parse(c.publishedAt));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    expect(times.filter((t) => t < 3_600_000).length).toBeGreaterThan(0);
    expect(times.filter((t) => t < 14 * 86_400_000).length).toBeGreaterThan(times.length * 0.5);
    expect(times.filter((t) => t > 28 * 86_400_000).length).toBeGreaterThan(0);
  });
});

describe('fake client', () => {
  const mk = (live = false) => {
    const world = createDemoWorld(42, NOW);
    return { world, client: createFakeClient(world, { live, now: () => NOW }) };
  };

  it('pages threads newest-first and errors like the real API', async () => {
    const { world, client } = mk();
    const vid = world.ownVideoIds[0] as string;
    const total = world.videos.get(vid)!.threads.length;
    const p1 = await client.listCommentThreads({ videoId: vid });
    expect(p1.items).toHaveLength(Math.min(100, total));
    const times = p1.items.map((t) => t.topComment.publishedAt);
    expect(times).toEqual([...times].sort().reverse());
    await expect(client.listCommentThreads({ videoId: DEMO_COMMENTS_DISABLED_VIDEO })).rejects.toMatchObject({
      reason: 'commentsDisabled',
    });
    await expect(client.listCommentThreads({ videoId: DEMO_MISSING_VIDEO })).rejects.toBeInstanceOf(YtError);
    expect(await client.getVideos([vid, DEMO_MISSING_VIDEO])).toHaveLength(1);
    expect((await client.getChannel({ handle: '@demochannel' }))?.id).toBe(DEMO_OWN_CHANNEL_ID);
  });

  it('inline replies are a subset; listReplies returns all', async () => {
    const { world, client } = mk();
    const t = [...world.videos.values()].flatMap((v) => v.threads).find((x) => x.replies.length >= 12)!;
    const page = await client.listCommentThreads({ videoId: t.videoId });
    const found = page.items.find((x) => x.id === t.id);
    if (found) {
      expect(found.replies.length).toBeLessThan(found.totalReplyCount);
      expect(found.totalReplyCount).toBe(t.replies.length);
    }
    expect((await client.listReplies({ parentId: t.id })).items).toHaveLength(t.replies.length);
  });

  it('own-channel feed spans videos', async () => {
    const { client } = mk();
    const page = await client.listCommentThreads({ allThreadsRelatedToChannelId: DEMO_OWN_CHANNEL_ID });
    expect(new Set(page.items.map((t) => t.videoId)).size).toBeGreaterThan(1);
  });

  it('tick() adds comments to hot videos; non-live mode never grows by itself', async () => {
    const { world, client } = mk(false);
    const before = world.totalComments();
    await client.listCommentThreads({ videoId: world.ownVideoIds[0] as string });
    expect(world.totalComments()).toBe(before);
    client.tick();
    expect(world.totalComments()).toBeGreaterThan(before);
  });

  it('live mode grows on its own after the interval', async () => {
    const world = createDemoWorld(42, NOW);
    let t = NOW.getTime();
    const client = createFakeClient(world, { live: true, now: () => new Date(t), growEveryMs: 1000 });
    const before = world.totalComments();
    for (let i = 0; i < 40; i++) {
      t += 2000;
      await client.listCommentThreads({ videoId: world.ownVideoIds[0] as string });
    }
    expect(world.totalComments()).toBeGreaterThan(before);
  });
});

describe('seedDemo + engine integration (real in-memory repo)', () => {
  it('seeds an empty repo and a full sync produces a plausible inbox', async () => {
    const world = createDemoWorld(42, NOW);
    const repo = createRepo(openDb(':memory:'), () => NOW);
    const yt = createFakeClient(world, { live: false, now: () => NOW });
    const bus = makeBus();
    const quota = createQuotaTracker({ repo, getSettings: () => repo.getSettings(), clock: () => NOW });
    const engine = createSyncEngine({ repo, yt, quota, bus, clock: () => NOW });
    const addSource = createAddSource({ repo, yt, engine, clock: () => NOW });

    await seedDemo(repo, addSource);
    expect(repo.getSettings().ownChannelIds).toEqual([DEMO_OWN_CHANNEL_ID]);
    const sources = repo.listSources();
    expect(sources.map((s) => s.kind).sort()).toEqual(['channel', 'playlist', 'playlist', 'video', 'video', 'video']);
    expect(sources.find((s) => s.kind === 'channel')?.isOwn).toBe(true);

    // seedDemo kicked off background syncs; wait for the queue to drain
    await engine.run({ trigger: 'manual', scope: 'all' });
    const counts = repo.counts();
    expect(counts.inbox).toBeGreaterThan(150);
    expect(repo.getVideoSyncRow(DEMO_COMMENTS_DISABLED_VIDEO)?.commentsDisabled).toBe(true);
    expect(repo.getVideoSyncRow(DEMO_MISSING_VIDEO)?.missing).toBe(true);
    const items = repo.listInbox({ view: 'done', limit: 500 }).items;
    expect(items.some((i) => i.comment.state === 'auto_replied')).toBe(true);
    expect(repo.lastRun()?.error).toBeNull();

    // idempotent: a second seed is a no-op
    await seedDemo(repo, addSource);
    expect(repo.listSources()).toHaveLength(6);
  }, 30_000);
});
