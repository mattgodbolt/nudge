import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../shared/types.js';
import { createRepo } from '../db/repo.js';
import { openDb } from '../db/db.js';
import { createEventBus } from '../events/bus.js';
import { createSnoozeWaker } from './snooze.js';

const T0 = Date.parse('2025-06-01T12:00:00.000Z');
let nowMs: number;

function setup() {
  const repo = createRepo(openDb(':memory:'), () => new Date(nowMs));
  const s = repo.addSource({
    kind: 'playlist',
    ytId: 'PLx',
    title: 'P',
    thumbnailUrl: null,
    isOwn: false,
    importMode: 'all',
  });
  repo.setSourceVideos(s.id, [{ id: 'v1', position: 0 }]);
  const published = new Date(T0 - 3_600_000).toISOString();
  repo.upsertThread({
    id: 'c1',
    videoId: 'v1',
    channelId: 'UCchan',
    canReply: true,
    totalReplyCount: 0,
    replies: [],
    topComment: {
      id: 'c1',
      parentId: null,
      videoId: 'v1',
      authorName: 'A',
      authorChannelId: 'UCx',
      authorAvatarUrl: null,
      textHtml: 'c1',
      likeCount: 0,
      publishedAt: published,
      updatedAt: published,
    },
  });
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { repo, bus, events };
}

beforeEach(() => {
  nowMs = T0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('createSnoozeWaker', () => {
  it('sweeps at start and on every interval, emitting only when something woke', () => {
    const { repo, bus, events } = setup();
    repo.snooze(['c1'], new Date(T0 + 20_000).toISOString());
    const waker = createSnoozeWaker({ repo, bus, intervalMs: 15_000 });
    waker.start();
    expect(events).toEqual([]); // initial sweep: not due yet

    nowMs += 15_000;
    vi.advanceTimersByTime(15_000);
    expect(events).toEqual([]);

    nowMs += 15_000;
    vi.advanceTimersByTime(15_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'inbox.changed', addedIds: ['c1'], changedIds: [] });
    expect((events[0] as { counts: { inbox: number } }).counts.inbox).toBe(1);

    nowMs += 15_000;
    vi.advanceTimersByTime(15_000);
    expect(events).toHaveLength(1);
    waker.stop();
  });

  it('catches up immediately on start and stops cleanly', () => {
    const { repo, bus, events } = setup();
    repo.snooze(['c1'], new Date(T0 + 60_000).toISOString());
    nowMs += 120_000; // e.g. the server was down
    const waker = createSnoozeWaker({ repo, bus });
    waker.start();
    waker.start(); // idempotent
    expect(events).toHaveLength(1);
    waker.stop();
    repo.snooze(['c1'], new Date(nowMs + 1000).toISOString());
    nowMs += 5_000;
    vi.advanceTimersByTime(60_000);
    expect(events).toHaveLength(1); // stopped: no further sweeps
    expect(waker.sweep()).toEqual(['c1']); // manual sweep still works
  });

  it('brings an until-activity snooze back at its fallback date, marked as an audit nag, with the same live event', () => {
    const { repo, bus, events } = setup();
    repo.snooze(['c1'], new Date(T0 + 7 * 86_400_000).toISOString(), 'waiting', {
      bucket: 'waiting_on_them',
      untilActivity: true,
    });
    const waker = createSnoozeWaker({ repo, bus });
    nowMs += 6 * 86_400_000; // before the fallback: nothing, and nothing is emitted
    expect(waker.sweep()).toEqual([]);
    expect(events).toEqual([]);
    nowMs += 86_400_000 + 1000;
    expect(waker.sweep()).toEqual(['c1']);
    expect(events[0]).toMatchObject({ type: 'inbox.changed', addedIds: ['c1'], reason: 'woke' });
    const row = repo.listInbox({ view: 'inbox' }).items[0]!;
    expect(row).toMatchObject({ wakeCause: 'fallback', snoozeNag: { bucket: 'waiting_on_them', days: 7 } });
  });

  it('leaves an item that already woke on activity alone (one wake per snooze)', () => {
    const { repo, bus, events } = setup();
    repo.snooze(['c1'], new Date(T0 + 7 * 86_400_000).toISOString(), null, { untilActivity: true });
    repo.upsertThread({
      id: 'c1',
      videoId: 'v1',
      channelId: 'UCchan',
      canReply: true,
      totalReplyCount: 1,
      replies: [
        {
          id: 'r1',
          parentId: 'c1',
          videoId: 'v1',
          authorName: 'B',
          authorChannelId: 'UCy',
          authorAvatarUrl: null,
          textHtml: 'r1',
          likeCount: 0,
          publishedAt: new Date(T0 + 60_000).toISOString(),
          updatedAt: new Date(T0 + 60_000).toISOString(),
        },
      ],
      topComment: {
        id: 'c1',
        parentId: null,
        videoId: 'v1',
        authorName: 'A',
        authorChannelId: 'UCx',
        authorAvatarUrl: null,
        textHtml: 'c1',
        likeCount: 0,
        publishedAt: new Date(T0 - 3_600_000).toISOString(),
        updatedAt: new Date(T0 - 3_600_000).toISOString(),
      },
    });
    expect(repo.listInbox({ view: 'inbox' }).items.find((i) => i.comment.id === 'c1')?.wakeCause).toBe('activity');
    nowMs += 8 * 86_400_000;
    expect(createSnoozeWaker({ repo, bus }).sweep()).toEqual([]);
    expect(events).toEqual([]);
  });
});
