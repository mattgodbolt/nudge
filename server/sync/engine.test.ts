import { describe, expect, it } from 'vitest';
import { YtError } from '../contracts.js';
import { OWN, comment, makeEnv, thread, ytVideo } from './test-helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const V1 = 'vidAAAAAAAA';
const V2 = 'vidBBBBBBBB';

const ago = (env: ReturnType<typeof makeEnv>, ms: number) => new Date(env.clock.now().getTime() - ms);
const stateOf = (env: ReturnType<typeof makeEnv>, id: string) => env.repo.getComment(id)?.state;
const syncVideo = (env: ReturnType<typeof makeEnv>, id: string, deep = false) =>
  env.engine.run({ trigger: 'manual', scope: 'video', id, deep });

describe('first sync and baseline', () => {
  it('imports comments older than the baseline as archived and stops after that page', async () => {
    const env = makeEnv();
    env.addVideo(V1, 40, 'recent'); // baseline = 14 days ago
    env.yt.pageSize = 2;
    env.yt.threads.set(V1, [
      thread('new1', V1, ago(env, 2 * DAY)),
      thread('old1', V1, ago(env, 20 * DAY)),
      thread('old2', V1, ago(env, 30 * DAY)), // page 2: must never be fetched
    ]);
    const s = await syncVideo(env, V1);
    expect(s.error).toBeNull();
    expect(s.videos).toBe(1);
    expect(s.newComments).toBe(1);
    expect(stateOf(env, 'new1')).toBe('inbox');
    expect(stateOf(env, 'old1')).toBe('archived');
    expect(env.repo.getComment('old2')).toBeNull();
    expect(env.yt.count('threads:')).toBe(1);
    expect(env.repo.getVideoSyncRow(V1)?.lastSyncedAt).not.toBeNull();
  });

  it('sets next_sync_at from the tier interval', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    await syncVideo(env, V1);
    expect(env.repo.getVideoSyncRow(V1)?.nextSyncAt).toBe(
      new Date(env.clock.now().getTime() + 10 * 60_000).toISOString(),
    );
  });
});

describe('incremental sync', () => {
  function bigVideo() {
    const env = makeEnv();
    env.addVideo(V1, 1);
    const threads = Array.from({ length: 250 }, (_, i) => thread(`t${i}`, V1, ago(env, (i + 1) * 60_000)));
    env.yt.threads.set(V1, threads);
    return env;
  }

  it('walks every page the first time, then stops after one page of known threads', async () => {
    const env = bigVideo();
    await syncVideo(env, V1);
    expect(env.yt.count('threads:')).toBe(3);
    env.yt.calls.length = 0;
    env.clock.advance(15 * 60_000);
    await syncVideo(env, V1);
    expect(env.yt.count('threads:')).toBe(1);
  });

  it('keeps paging while pages contain new threads, and stops at the first fully known page', async () => {
    const env = bigVideo();
    await syncVideo(env, V1);
    env.yt.calls.length = 0;
    env.clock.advance(15 * 60_000);
    env.yt.threads.set(V1, [thread('fresh', V1, env.clock.now()), ...(env.yt.threads.get(V1) ?? [])]);
    const s = await syncVideo(env, V1);
    expect(s.newComments).toBe(1);
    expect(env.yt.count('threads:')).toBe(2); // page 1 had news; page 2 was all known
    expect(stateOf(env, 'fresh')).toBe('inbox');
  });

  it("does a deep scan once the tier's deep interval has passed", async () => {
    const env = bigVideo();
    await syncVideo(env, V1);
    env.yt.calls.length = 0;
    env.clock.advance(7 * HOUR); // hot videos deep scan every 6h
    await syncVideo(env, V1);
    expect(env.yt.count('threads:')).toBe(3);
    env.yt.calls.length = 0;
    env.clock.advance(15 * 60_000);
    await syncVideo(env, V1);
    expect(env.yt.count('threads:')).toBe(1);
  });

  it('explicit deep requests walk everything', async () => {
    const env = bigVideo();
    await syncVideo(env, V1);
    env.yt.calls.length = 0;
    await syncVideo(env, V1, true);
    expect(env.yt.count('threads:')).toBe(3);
  });

  it('notices a changed reply count on page one (reply on a recent thread)', async () => {
    const env = bigVideo();
    await syncVideo(env, V1);
    env.yt.calls.length = 0;
    env.clock.advance(15 * 60_000);
    const list = env.yt.threads.get(V1) ?? [];
    const r = comment('t0.r1', V1, env.clock.now(), { parentId: 't0' });
    env.yt.threads.set(V1, [{ ...(list[0] as never), totalReplyCount: 1, replies: [r] }, ...list.slice(1)]);
    const s = await syncVideo(env, V1);
    expect(s.newComments).toBe(1);
    expect(stateOf(env, 't0.r1')).toBe('inbox');
    expect(env.yt.count('threads:')).toBe(2);
  });
});

describe('replies', () => {
  it('fetches the remaining replies (paginated) when inline replies are only a subset', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    const replies = Array.from({ length: 130 }, (_, i) =>
      comment(`T.r${i}`, V1, ago(env, (200 - i) * 60_000), { parentId: 'T' }),
    );
    env.yt.threads.set(V1, [thread('T', V1, ago(env, 3 * HOUR), replies, 5)]);
    env.yt.replies.set('T', replies);
    await syncVideo(env, V1);
    expect(env.yt.count('replies:T')).toBe(2); // 100 + 30
    expect(env.repo.getThread('T')?.comments).toHaveLength(131);
    expect(env.repo.getThreadState('T')).toMatchObject({ totalReplyCount: 130, fetchedReplyCount: 130 });

    env.yt.calls.length = 0;
    env.clock.advance(15 * 60_000);
    await syncVideo(env, V1);
    expect(env.yt.count('replies:')).toBe(0); // nothing changed, nothing fetched
  });

  it('does not call listReplies when the inline replies are complete', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    const replies = [comment('T.r1', V1, ago(env, HOUR)), comment('T.r2', V1, ago(env, HOUR / 2))];
    env.yt.threads.set(V1, [thread('T', V1, ago(env, 3 * HOUR), replies)]);
    await syncVideo(env, V1);
    expect(env.yt.count('replies:')).toBe(0);
    expect(env.repo.getThread('T')?.comments).toHaveLength(3);
  });
});

describe('own replies', () => {
  it('auto-clears earlier inbox comments in a thread the own channel answered', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    const ownReply = comment('A.own', V1, ago(env, HOUR), { authorChannelId: OWN, authorName: 'Me' });
    const later = comment('B.r1', V1, ago(env, 10 * 60_000));
    env.yt.threads.set(V1, [
      thread(
        'B',
        V1,
        ago(env, 3 * HOUR),
        [later].map((c) => ({ ...c, publishedAt: c.publishedAt })),
      ),
      thread('A', V1, ago(env, 5 * HOUR), [ownReply]),
    ]);
    await syncVideo(env, V1);
    expect(stateOf(env, 'A')).toBe('auto_replied');
    expect(stateOf(env, 'A.own')).toBe('own');
    expect(stateOf(env, 'B')).toBe('inbox');
    expect(stateOf(env, 'B.r1')).toBe('inbox');
  });
});

describe('errors and backoff', () => {
  it('flags comments-disabled videos, rechecks after a week', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    env.yt.errors.set(V1, new YtError('commentsDisabled', 'off', 403));
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    let row = env.repo.getVideoSyncRow(V1);
    expect(row?.commentsDisabled).toBe(true);
    expect(row?.nextSyncAt).toBe(new Date(env.clock.now().getTime() + 7 * DAY).toISOString());
    expect(env.yt.count('threads:')).toBe(1);

    env.clock.advance(2 * DAY);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('threads:')).toBe(1); // not due yet

    env.clock.advance(6 * DAY);
    env.yt.errors.delete(V1); // owner re-enabled comments
    env.yt.threads.set(V1, [thread('t', V1, ago(env, HOUR))]);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    row = env.repo.getVideoSyncRow(V1);
    expect(row?.commentsDisabled).toBe(false);
    expect(stateOf(env, 't')).toBe('inbox');
  });

  it('marks a not-found video as missing', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    env.yt.errors.set(V1, new YtError('notFound', 'gone', 404));
    await syncVideo(env, V1);
    expect(env.repo.getVideoSyncRow(V1)?.missing).toBe(true);
    env.yt.calls.length = 0;
    await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(env.yt.count('threads:')).toBe(0);
  });

  it('applies exponential backoff (2^n x 5 min) and skips videos in backoff', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    env.yt.errors.set(V1, new YtError('unknown', 'boom', 500));
    await env.engine.run({ trigger: 'manual', scope: 'all' });
    let row = env.repo.getVideoSyncRow(V1);
    expect(row?.errorCount).toBe(1);
    expect(row?.backoffUntil).toBe(new Date(env.clock.now().getTime() + 10 * 60_000).toISOString());
    expect(row?.lastError).toBe('boom');
    expect(env.bus.of('error')).toHaveLength(1);

    env.yt.calls.length = 0;
    env.clock.advance(5 * 60_000);
    await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(env.yt.count('threads:')).toBe(0); // still backing off

    env.clock.advance(6 * 60_000);
    await env.engine.run({ trigger: 'manual', scope: 'all' });
    row = env.repo.getVideoSyncRow(V1);
    expect(row?.errorCount).toBe(2);
    expect(row?.backoffUntil).toBe(new Date(env.clock.now().getTime() + 20 * 60_000).toISOString());

    // success resets
    env.yt.errors.delete(V1);
    env.clock.advance(HOUR);
    await env.engine.run({ trigger: 'manual', scope: 'all' });
    row = env.repo.getVideoSyncRow(V1);
    expect(row).toMatchObject({ errorCount: 0, backoffUntil: null, lastError: null });
  });

  it('caps the backoff at 24h', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    env.repo.updateVideoSync(V1, { errorCount: 20 });
    env.yt.errors.set(V1, new YtError('unknown', 'boom'));
    await syncVideo(env, V1);
    expect(env.repo.getVideoSyncRow(V1)?.backoffUntil).toBe(new Date(env.clock.now().getTime() + DAY).toISOString());
  });

  it('quotaExceeded aborts the run, blocks until Pacific midnight and emits quota.update', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    env.addVideo(V2, 1);
    env.yt.errors.set(V1, new YtError('quotaExceeded', 'quota', 403));
    env.yt.errors.set(V2, new YtError('quotaExceeded', 'quota', 403));
    const s = await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(s.error).toMatch(/quota/i);
    expect(env.yt.count('threads:')).toBe(1); // second video never tried
    const snap = env.quota.snapshot();
    expect(snap.blockedUntil).not.toBeNull();
    expect(env.bus.of('quota.update').at(-1)?.quota.blockedUntil).toBe(snap.blockedUntil);
    expect(env.repo.getVideoSyncRow(V1)?.errorCount).toBe(0); // quota is not the video's fault

    env.yt.calls.length = 0;
    const again = await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(env.yt.calls).toHaveLength(0);
    expect(again.videos).toBe(0);
  });

  it('stops a poll run at budget minus reserve, but lets a manual run use the reserve', async () => {
    const env = makeEnv({ settings: { dailyQuotaBudget: 100, manualReserve: 30 } });
    env.addVideo(V1, 1);
    env.repo.recordQuota(env.quota.dayPt(), 'x', 70);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.calls).toHaveLength(0);
    const s = await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(env.yt.count('threads:')).toBe(1);
    expect(s.error).toBeNull();
  });

  it('aborts after repeated network failures instead of backing off every video', async () => {
    const env = makeEnv();
    for (const id of ['vidCCCCCCC1', 'vidCCCCCCC2', 'vidCCCCCCC3', 'vidCCCCCCC4']) {
      env.addVideo(id, 1);
      env.yt.errors.set(id, new YtError('network', 'offline'));
    }
    const s = await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(s.error).toMatch(/offline/);
    expect(env.yt.count('threads:')).toBe(3);
  });
});

describe('scheduling semantics', () => {
  it('poll runs do nothing (and record nothing) when nothing is due', async () => {
    const env = makeEnv();
    const s = await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(s.id).toBe(0);
    expect(env.repo.lastRun()).toBeNull();
    expect(env.bus.events).toHaveLength(0);
  });

  it('poll only touches due videos; manual sync-all touches every unpaused one, hot first', async () => {
    const env = makeEnv();
    env.addVideo('vidOLD00000', 100);
    env.addVideo('vidHOT00000', 1);
    env.addVideo('vidPAUSED00', 1);
    env.repo.setVideoTier('vidPAUSED00', 'paused');
    await env.engine.run({ trigger: 'manual', scope: 'all' });
    expect(env.yt.calls.filter((c) => c.startsWith('threads:')).map((c) => c.split(':')[1])).toEqual([
      'vidHOT00000',
      'vidOLD00000',
    ]);

    env.yt.calls.length = 0;
    env.clock.advance(11 * 60_000); // only the hot one is due again
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.calls.filter((c) => c.startsWith('threads:')).map((c) => c.split(':')[1])).toEqual(['vidHOT00000']);
  });

  it('own-channel videos are polled one tier colder', async () => {
    const env = makeEnv();
    const src = env.addVideo(V1, 1);
    env.repo.updateVideoSync(V1, {});
    // mark the video as belonging to the own channel
    env.repo.upsertVideos([ytVideo(V1, ago(env, DAY), { channelId: OWN })]);
    void src;
    await syncVideo(env, V1);
    expect(env.repo.getVideoSyncRow(V1)?.nextSyncAt).toBe(
      new Date(env.clock.now().getTime() + 60 * 60_000).toISOString(),
    );
  });
});

describe('own channel feed', () => {
  it('uses allThreadsRelatedToChannelId, attaches unknown videos lazily and imports their threads', async () => {
    const env = makeEnv();
    env.yt.playlists.set('UUown', []);
    const src = env.repo.addSource({
      kind: 'channel',
      ytId: OWN,
      title: 'Me',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'recent',
      uploadsPlaylistId: 'UUown',
    });
    env.yt.videos.set('vidFEED0001', ytVideo('vidFEED0001', ago(env, 2 * DAY), { channelId: OWN }));
    env.yt.threads.set('vidFEED0001', [
      thread('F1', 'vidFEED0001', ago(env, HOUR)),
      thread('F0', 'vidFEED0001', ago(env, 2 * HOUR)),
    ]);
    const s = await env.engine.run({ trigger: 'manual', scope: 'source', id: src.id });
    expect(s.error).toBeNull();
    expect(env.yt.count('threads:feed:' + OWN)).toBe(1);
    expect(env.yt.count('videos:vidFEED0001')).toBe(1);
    expect(env.repo.getVideoSyncRow('vidFEED0001')).not.toBeNull();
    expect(stateOf(env, 'F1')).toBe('inbox');
    expect(env.repo.allVideoRows(src.id).map((v) => v.id)).toContain('vidFEED0001');
  });

  it('throttles the feed in poll runs to once per 10 minutes', async () => {
    const env = makeEnv();
    env.yt.playlists.set('UUown', []);
    env.repo.addSource({
      kind: 'channel',
      ytId: OWN,
      title: 'Me',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'recent',
      uploadsPlaylistId: 'UUown',
    });
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('threads:feed')).toBe(1);
    env.clock.advance(5 * 60_000);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('threads:feed')).toBe(1);
    env.clock.advance(6 * 60_000);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('threads:feed')).toBe(2);
  });
});

describe('membership', () => {
  it('refreshes a playlist hourly: attaches new videos with metadata and flags unavailable ones as missing', async () => {
    const env = makeEnv();
    env.yt.playlists.set('PLabcdefghijk', [V1]);
    env.yt.videos.set(V1, ytVideo(V1, ago(env, DAY)));
    const src = env.repo.addSource({
      kind: 'playlist',
      ytId: 'PLabcdefghijk',
      title: 'P',
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.repo.allVideoRows(src.id).map((v) => v.id)).toEqual([V1]);
    expect(env.repo.listVideos(src.id)[0]?.title).toBe(`Video ${V1}`);
    expect(env.repo.getSourceRow(src.id)?.membershipRefreshedAt).not.toBeNull();

    env.yt.playlists.set('PLabcdefghijk', [V1, 'vidPRIVATE01']);
    env.clock.advance(30 * 60_000);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('playlistItems')).toBe(1); // not stale yet
    env.clock.advance(31 * 60_000);
    await env.engine.run({ trigger: 'poll', scope: 'all' });
    expect(env.yt.count('playlistItems')).toBe(2);
    expect(env.repo.getVideoSyncRow('vidPRIVATE01')?.missing).toBe(true);
  });
});

describe('events', () => {
  it('emits progress, one inbox.changed per video with only inbox ids, then sync.done', async () => {
    const env = makeEnv();
    env.addVideo(V1, 40, 'recent');
    env.addVideo(V2, 1);
    env.yt.threads.set(V1, [thread('a1', V1, ago(env, DAY)), thread('a2', V1, ago(env, 25 * DAY))]);
    env.yt.threads.set(V2, [thread('b1', V2, ago(env, HOUR))]);
    const s = await env.engine.run({ trigger: 'manual', scope: 'all' });
    const changed = env.bus.of('inbox.changed');
    const added = changed.flatMap((e) => e.addedIds).sort();
    expect(added).toEqual(['a1', 'b1']); // a2 is archived
    expect(s.newComments).toBe(2);
    expect(changed.at(-1)?.counts.inbox).toBe(2);
    const done = env.bus.of('sync.done');
    expect(done).toHaveLength(1);
    expect(done[0]?.summary).toMatchObject({ videos: 2, newComments: 2, error: null });
    const progress = env.bus.of('sync.progress');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.some((e) => e.status.running)).toBe(true);
    expect(progress.at(-1)?.status.running).toBe(false);
    expect(env.bus.events.at(-1)?.type).toBe('sync.progress');
    expect(env.engine.status().lastRun?.id).toBe(s.id);
  });

  it('emits changedIds when auto-clear moves comments out of the inbox', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    env.yt.threads.set(V1, [thread('c1', V1, ago(env, 3 * HOUR))]);
    await syncVideo(env, V1);
    env.bus.events.length = 0;
    env.clock.advance(15 * 60_000);
    const own = comment('c1.own', V1, env.clock.now(), { authorChannelId: OWN, parentId: 'c1' });
    env.yt.threads.set(V1, [thread('c1', V1, ago(env, 3 * HOUR), [own])]);
    await syncVideo(env, V1);
    expect(stateOf(env, 'c1')).toBe('auto_replied');
    const ev = env.bus.of('inbox.changed');
    expect(ev.flatMap((e) => e.changedIds)).toContain('c1');
    expect(ev.at(-1)?.counts.inbox).toBe(0);
  });
});

describe('run merging', () => {
  async function until(cond: () => boolean) {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond()).toBe(true);
  }

  it('runs one at a time; a manual request during a poll waits for it, and duplicate requests merge', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    env.yt.threads.set(V1, [thread('t1', V1, ago(env, HOUR))]);
    let release!: () => void;
    env.yt.gate = new Promise<void>((r) => (release = r));

    const poll = env.engine.run({ trigger: 'poll', scope: 'all' });
    await until(() => env.yt.calls.length > 0);
    expect(env.engine.status().running).toBe(true);
    const m1 = env.engine.run({ trigger: 'manual', scope: 'all' });
    const m2 = env.engine.run({ trigger: 'manual', scope: 'all', deep: true });
    release();

    const [p, a, b] = await Promise.all([poll, m1, m2]);
    expect(a.id).toBe(b.id); // merged into a single run
    expect(env.bus.of('sync.done').map((e) => e.summary.trigger)).toEqual(['poll', 'manual']);
    expect(p.trigger).toBe('poll');
    expect(a.trigger).toBe('manual');
    // never two runs in flight: every progress event with running=true is between start and sync.done
    let open = 0;
    for (const e of env.bus.events) {
      if (e.type === 'sync.progress' && e.status.running && open === 0) open = 1;
      if (e.type === 'sync.done') open = 0;
      if (e.type === 'sync.progress' && !e.status.running) expect(open).toBe(0);
    }
  });

  it('upgrades a queued poll to manual when a manual request for the same scope arrives', async () => {
    const env = makeEnv();
    env.addVideo(V1, 1);
    let release!: () => void;
    env.yt.gate = new Promise<void>((r) => (release = r));
    const first = env.engine.run({ trigger: 'manual', scope: 'video', id: V1 });
    await until(() => env.yt.calls.length > 0);
    const queuedPoll = env.engine.run({ trigger: 'poll', scope: 'all' });
    const queuedManual = env.engine.run({ trigger: 'manual', scope: 'all' });
    release();
    const [, p, m] = await Promise.all([first, queuedPoll, queuedManual]);
    expect(p.id).toBe(m.id);
    expect(m.trigger).toBe('manual');
  });
});
