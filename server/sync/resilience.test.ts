// Regression tests for partial-failure handling: resumable scans, reply retries, quota mid-scan, backoff.
import { describe, expect, it } from 'vitest';
import { YtError } from '../contracts.js';
import { OWN, comment, makeEnv, thread, ytVideo } from './test-helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const V1 = 'vidAAAAAAAA';

type Env = ReturnType<typeof makeEnv>;
const ago = (env: Env, ms: number) => new Date(env.clock.now().getTime() - ms);
const syncVideo = (env: Env, id: string, deep = false) =>
  env.engine.run({ trigger: 'manual', scope: 'video', id, deep });

/** Make the nth call matching `match` throw once. */
function failOnce(env: Env, match: (call: string) => boolean, err: YtError) {
  const orig = env.yt.listCommentThreads.bind(env.yt);
  let armed = true;
  env.yt.listCommentThreads = async (p) => {
    const key = `threads:${p.videoId ?? 'feed:' + p.allThreadsRelatedToChannelId}:${p.pageToken ?? ''}`;
    if (armed && match(key)) {
      armed = false;
      env.yt.calls.push(key);
      throw err;
    }
    return orig(p);
  };
}

function fourThreads(env: Env) {
  env.yt.pageSize = 2;
  env.yt.threads.set(
    V1,
    [1, 2, 3, 4].map((i) => thread(`t${i}`, V1, ago(env, i * HOUR))),
  );
}

describe('resumable incremental scans', () => {
  it('a first-time scan that fails on page 2 still reaches the older pages next time', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    fourThreads(env);
    failOnce(env, (c) => c === `threads:${V1}:2`, new YtError('unknown', 'boom', 500));
    const first = await syncVideo(env, V1);
    expect(first.videos).toBe(0);
    expect(env.repo.getVideoSyncRow(V1)?.scanIncomplete).toBe(true);
    expect(env.repo.getComment('t3')).toBeNull();

    const second = await syncVideo(env, V1);
    expect(second.error).toBeNull();
    expect(env.repo.getComment('t3')).not.toBeNull();
    expect(env.repo.getComment('t4')).not.toBeNull();
    expect(env.repo.getVideoSyncRow(V1)?.scanIncomplete).toBe(false);
  });

  it('after a clean scan the marker is clear and the all-known page rule applies again', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    fourThreads(env);
    await syncVideo(env, V1);
    expect(env.repo.getVideoSyncRow(V1)?.scanIncomplete).toBe(false);
    env.yt.calls.length = 0;
    env.clock.advance(15 * 60_000);
    await syncVideo(env, V1);
    expect(env.yt.count('threads:')).toBe(1);
  });

  it('an interrupted own-channel feed scan resumes past all-known pages', async () => {
    const env = makeEnv();
    env.yt.playlists.set('UUown', []);
    const src = env.repo.addSource({
      kind: 'channel',
      ytId: OWN,
      title: 'Me',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'all',
      uploadsPlaylistId: 'UUown',
    });
    env.yt.videos.set(V1, ytVideo(V1, ago(env, DAY), { channelId: OWN }));
    fourThreads(env);
    failOnce(env, (c) => c === `threads:feed:${OWN}:2`, new YtError('unknown', 'boom', 500));
    await env.engine.run({ trigger: 'manual', scope: 'source', id: src.id });
    expect(env.repo.getSourceRow(src.id)?.feedScanIncomplete).toBe(true);

    // The per-video sync in that run imported everything, so only the marker can make the feed read page 2.
    env.yt.calls.length = 0;
    await env.engine.run({ trigger: 'manual', scope: 'source', id: src.id });
    expect(env.yt.count(`threads:feed:${OWN}:2`)).toBe(1);
    expect(env.repo.getSourceRow(src.id)?.feedScanIncomplete).toBe(false);
  });
});

describe('reply fetch retries', () => {
  function withReplies(env: Env, total: number, inline = 1) {
    const replies = Array.from({ length: total }, (_, i) =>
      comment(`T.r${i}`, V1, ago(env, (100 - i) * 60_000), { parentId: 'T' }),
    );
    env.yt.threads.set(V1, [thread('T', V1, ago(env, 3 * HOUR), replies, inline)]);
    env.yt.replies.set('T', replies);
    return replies;
  }

  it('retries when listReplies failed after the new total was already stored', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    withReplies(env, 3);
    const origReplies = env.yt.listReplies.bind(env.yt);
    let fail = true;
    env.yt.listReplies = async (p) => {
      if (fail) {
        fail = false;
        throw new YtError('unknown', 'boom', 500);
      }
      return origReplies(p);
    };
    await syncVideo(env, V1);
    expect(env.repo.getThreadState('T')).toMatchObject({ totalReplyCount: 3, fetchedReplyCount: 1 });

    env.clock.advance(15 * 60_000);
    await syncVideo(env, V1);
    expect(env.repo.getThreadState('T')).toMatchObject({ totalReplyCount: 3, fetchedReplyCount: 3 });
  });

  it('does not refetch every poll when replies can never reach the total, but does once per interval', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    const replies = withReplies(env, 3);
    env.yt.replies.set('T', replies.slice(0, 2)); // one reply is held/deleted: never returned
    await syncVideo(env, V1);
    expect(env.yt.count('replies:T')).toBe(1);

    for (let i = 0; i < 3; i++) {
      env.clock.advance(15 * 60_000);
      await syncVideo(env, V1);
    }
    expect(env.yt.count('replies:T')).toBe(1);

    env.clock.advance(7 * HOUR);
    await syncVideo(env, V1);
    expect(env.yt.count('replies:T')).toBe(2);
  });

  it('refetches immediately when the total grows, even right after a successful fetch', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    const replies = withReplies(env, 2);
    await syncVideo(env, V1);
    expect(env.yt.count('replies:T')).toBe(1);
    const more = [...replies, comment('T.r2', V1, ago(env, 60_000), { parentId: 'T' })];
    env.yt.threads.set(V1, [thread('T', V1, ago(env, 3 * HOUR), more, 1)]);
    env.yt.replies.set('T', more);
    env.clock.advance(15 * 60_000);
    await syncVideo(env, V1);
    expect(env.repo.getThreadState('T')).toMatchObject({ totalReplyCount: 3, fetchedReplyCount: 3 });
  });
});

describe('quota inside a scan', () => {
  it('stops paging once the budget is gone and resumes later', async () => {
    const env = makeEnv();
    env.repo.updateSettings({ dailyQuotaBudget: 100, manualReserve: 10 });
    env.addVideo(V1, 1);
    fourThreads(env);
    const orig = env.yt.listCommentThreads.bind(env.yt);
    env.yt.listCommentThreads = async (p) => {
      const r = await orig(p);
      env.quota.charge('commentThreads.list', 100); // budget exhausted after the first page
      return r;
    };
    const s = await syncVideo(env, V1);
    expect(env.yt.count('threads:')).toBe(1);
    expect(s.error).toMatch(/quota/i);
    expect(env.repo.getVideoSyncRow(V1)).toMatchObject({ scanIncomplete: true, lastSyncedAt: null });

    env.yt.listCommentThreads = orig;
    env.clock.advance(2 * DAY); // next Pacific day: fresh budget
    await syncVideo(env, V1);
    expect(env.repo.getComment('t4')).not.toBeNull();
    expect(env.repo.getVideoSyncRow(V1)?.scanIncomplete).toBe(false);
  });
});

describe('video metadata stubs', () => {
  it('fetches metadata before choosing a tier when an earlier getVideos failed', async () => {
    const env = makeEnv();
    env.yt.videos.set(V1, ytVideo(V1, ago(env, 60 * DAY)));
    env.yt.playlists.set('PLx', [V1]);
    const src = env.repo.addSource({
      kind: 'playlist',
      ytId: 'PLx',
      title: 'P',
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    const origGet = env.yt.getVideos.bind(env.yt);
    let fail = true;
    env.yt.getVideos = async (ids) => {
      if (fail) {
        throw new YtError('unknown', 'boom', 500);
      }
      return origGet(ids);
    };
    const first = await env.engine.run({ trigger: 'manual', scope: 'source', id: src.id });
    expect(first.error).toBeNull(); // membership failure is non-fatal
    expect(env.repo.getVideoSyncRow(V1)?.metaRefreshedAt).toBeNull();

    // The next membership refresh re-fetches stubs even though they are no longer "added".
    fail = false;
    await env.engine.run({ trigger: 'manual', scope: 'source', id: src.id });
    const row = env.repo.getVideoSyncRow(V1);
    expect(row?.metaRefreshedAt).not.toBeNull();
    expect(row?.publishedAt).not.toBeNull();
  });

  it('syncing a stub video fetches its metadata first', async () => {
    const env = makeEnv();
    env.yt.videos.set(V1, ytVideo(V1, ago(env, 60 * DAY)));
    const src = env.repo.addSource({
      kind: 'video',
      ytId: V1,
      title: V1,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    env.repo.setSourceVideos(src.id, [{ id: V1, position: 0 }]); // stub only
    await syncVideo(env, V1);
    expect(env.repo.getVideoSyncRow(V1)?.publishedAt).not.toBeNull();
    expect(env.yt.calls.findIndex((c) => c.startsWith('videos:'))).toBeLessThan(
      env.yt.calls.findIndex((c) => c.startsWith('threads:')),
    );
  });
});

describe('threads without a video id', () => {
  it('are skipped instead of creating a stub for the empty id', async () => {
    const env = makeEnv();
    env.yt.playlists.set('UUown', []);
    const src = env.repo.addSource({
      kind: 'channel',
      ytId: OWN,
      title: 'Me',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'all',
      uploadsPlaylistId: 'UUown',
    });
    env.yt.videos.set(V1, ytVideo(V1, ago(env, DAY), { channelId: OWN }));
    env.yt.threads.set(V1, [thread('good', V1, ago(env, HOUR)), thread('bad', '', ago(env, 2 * HOUR))]);
    await env.engine.run({ trigger: 'manual', scope: 'source', id: src.id });
    expect(env.yt.calls.filter((c) => c === 'videos:')).toEqual([]);
    expect(env.repo.getVideoSyncRow('')).toBeNull();
    expect(env.repo.getComment('good')).not.toBeNull();
    expect(env.repo.getComment('bad')).toBeNull();
  });
});

describe('failure backoff for background polls', () => {
  function feedEnv() {
    const env = makeEnv();
    env.yt.playlists.set('UUown', []);
    const src = env.repo.addSource({
      kind: 'channel',
      ytId: OWN,
      title: 'Me',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'all',
      uploadsPlaylistId: 'UUown',
    });
    return { env, src };
  }

  it('backs off a failing feed exponentially instead of retrying every tick', async () => {
    const { env } = feedEnv();
    const orig = env.yt.listCommentThreads.bind(env.yt);
    env.yt.listCommentThreads = async (p) => {
      if (p.allThreadsRelatedToChannelId) {
        env.yt.calls.push('threads:feed:fail');
        throw new YtError('unknown', 'boom', 500);
      }
      return orig(p);
    };
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('threads:feed:fail')).toBe(1);
    for (let i = 0; i < 2; i++) {
      env.clock.advance(30_000);
      await env.engine.run({ trigger: 'poll', scope: 'all' });
    }
    expect(env.yt.count('threads:feed:fail')).toBe(1); // 2 min backoff after the first failure
    env.clock.advance(11 * 60_000);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('threads:feed:fail')).toBe(2);
    // A manual sync always tries.
    await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(env.yt.count('threads:feed:fail')).toBe(3);
  });

  it('stops polling after keyInvalid until the key changes or a manual sync happens', async () => {
    const { env } = feedEnv();
    env.repo.updateSettings({ apiKey: 'bad' });
    const orig = env.yt.listCommentThreads.bind(env.yt);
    let rejecting = true;
    env.yt.listCommentThreads = async (p) => {
      if (rejecting) {
        env.yt.calls.push('threads:rejected');
        throw new YtError('keyInvalid', 'API key not valid', 400);
      }
      return orig(p);
    };
    const first = await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(first.error).toMatch(/key/i);
    for (let i = 0; i < 3; i++) {
      env.clock.advance(11 * 60_000);
      await env.engine.run({ trigger: 'poll', scope: 'all' });
    }
    expect(env.yt.count('threads:rejected')).toBe(1);

    rejecting = false;
    env.repo.updateSettings({ apiKey: 'good' });
    env.clock.advance(11 * 60_000);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.calls.some((c) => c.startsWith('threads:feed'))).toBe(true);
  });
});
