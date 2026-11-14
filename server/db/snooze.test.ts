import { beforeEach, describe, expect, it } from 'vitest';
import type { Repo, YtComment, YtThread } from '../contracts.js';
import { createRepo, UndoError } from './repo.js';
import { openDb } from './db.js';

const T0 = new Date('2025-06-01T12:00:00.000Z');
let nowMs = T0.getTime();
const hours = (h: number) => h * 3_600_000;
const at = (h: number) => new Date(T0.getTime() + hours(h)).toISOString();
const advance = (ms: number) => {
  nowMs += ms;
};

function thread(id: string, publishedAt: string, videoId = 'vid1'): YtThread {
  const topComment: YtComment = {
    id,
    parentId: null,
    videoId,
    authorName: `Author ${id}`,
    authorChannelId: `UCa_${id}`,
    authorAvatarUrl: null,
    textHtml: `text of ${id}`,
    likeCount: 0,
    publishedAt,
    updatedAt: publishedAt,
  };
  return { id, videoId, channelId: 'UCchan', canReply: true, topComment, totalReplyCount: 0, replies: [] };
}

let repo: Repo;
let sourceId: number;
const inboxIds = (view: 'inbox' | 'snoozed' | 'done' | 'all' = 'inbox') =>
  repo.listInbox({ view, limit: 500 }).items.map((i) => i.comment.id);

beforeEach(() => {
  nowMs = T0.getTime();
  repo = createRepo(openDb(':memory:'), () => new Date(nowMs));
  const s = repo.addSource({
    kind: 'playlist',
    ytId: 'PLx',
    title: 'P',
    thumbnailUrl: null,
    isOwn: false,
    importMode: 'all',
  });
  repo.setSourceVideos(s.id, [{ id: 'vid1', position: 0 }]);
  sourceId = s.id;
  // newest first: c1 > c2 > c3 > c4
  for (const [i, id] of ['c1', 'c2', 'c3', 'c4'].entries()) repo.upsertThread(thread(id, at(-1 - i)));
});

describe('snooze', () => {
  it('hides snoozed comments from the inbox, shows them in the snoozed view and counts them', () => {
    const r = repo.snooze(['c1', 'c2'], at(5));
    expect(r.actionId).toEqual(expect.any(Number));
    expect(r.changes).toEqual([
      { commentId: 'c1', from: null, to: at(5) },
      { commentId: 'c2', from: null, to: at(5) },
    ]);
    expect(inboxIds()).toEqual(['c3', 'c4']);
    expect(inboxIds('snoozed')).toEqual(['c1', 'c2']);
    expect(inboxIds('all')).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(r.counts).toMatchObject({ inbox: 2, snoozed: 2, all: 4, bySource: { [sourceId]: 2 } });
    const item = repo.listInbox({ view: 'snoozed' }).items[0]!;
    expect(item.snoozedUntil).toBe(at(5));
    expect(item.wokeAt).toBeNull();
  });

  it('skips unknown and non-inbox comments and does not report idempotent no-ops', () => {
    repo.triage(['c3'], 'done');
    const r = repo.snooze(['c3', 'nope', 'c1'], at(5));
    expect(r.changes.map((c) => c.commentId)).toEqual(['c1']);
    const again = repo.snooze(['c1'], at(5));
    expect(again).toMatchObject({ actionId: null, changes: [] });
    expect(repo.snooze(['c2'], null)).toMatchObject({ actionId: null, changes: [] });
  });

  it('unsnoozes with null and leaves woke_at alone', () => {
    repo.snooze(['c1'], at(1));
    advance(hours(2));
    repo.wakeSnoozed();
    repo.snooze(['c1'], at(10)); // re-snooze clears woke_at
    expect(repo.listInbox({ view: 'snoozed' }).items[0]!.wokeAt).toBeNull();
    const r = repo.snooze(['c1'], null);
    expect(r.changes).toEqual([{ commentId: 'c1', from: at(10), to: null }]);
    expect(inboxIds()).toContain('c1');
  });

  it('undoes a snooze, restoring the previous snoozed_until and woke_at', () => {
    repo.snooze(['c1'], at(1));
    advance(hours(2));
    repo.wakeSnoozed(); // c1: woke_at = at(1)
    const s = repo.snooze(['c1', 'c2'], at(20));
    const u = repo.undoSnooze(s.actionId!);
    expect(u.changes).toEqual([
      { commentId: 'c1', from: at(20), to: null },
      { commentId: 'c2', from: at(20), to: null },
    ]);
    const items = repo.listInbox({ view: 'inbox' }).items;
    expect(items.find((i) => i.comment.id === 'c1')!.wokeAt).toBe(at(1));
    expect(u.counts.snoozed).toBe(0);
    expect(() => repo.undoSnooze(s.actionId!)).toThrowError(expect.objectContaining({ code: 'already_undone' }));
  });

  it('does not clobber a later change when undoing', () => {
    const s = repo.snooze(['c1'], at(5));
    repo.snooze(['c1'], at(9));
    expect(repo.undoSnooze(s.actionId!).changes).toEqual([]);
    expect(repo.listInbox({ view: 'snoozed' }).items[0]!.snoozedUntil).toBe(at(9));
  });

  it('expires the undo window and keeps snooze and triage undo apart', () => {
    const s = repo.snooze(['c1'], at(100));
    const t = repo.triage(['c2'], 'done');
    expect(() => repo.undo(s.actionId!)).toThrowError(UndoError);
    expect(() => repo.undo(s.actionId!)).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(() => repo.undoSnooze(t.actionId)).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(() => repo.undoSnooze(999)).toThrowError(expect.objectContaining({ code: 'not_found' }));
    advance(hours(25));
    expect(() => repo.undoSnooze(s.actionId!)).toThrowError(expect.objectContaining({ code: 'expired' }));
  });

  it('triage back to inbox clears a snooze, even for a comment already in the inbox', () => {
    repo.snooze(['c1', 'c2'], at(50));
    repo.triage(['c2'], 'done');
    const r = repo.triage(['c1', 'c2'], 'inbox');
    expect(r.changes).toEqual([{ commentId: 'c2', from: 'done', to: 'inbox' }]);
    expect(inboxIds()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(r.counts.snoozed).toBe(0);
  });

  it('triage to done leaves the snooze fields alone', () => {
    repo.snooze(['c1'], at(50));
    repo.triage(['c1'], 'done');
    expect(inboxIds('done')).toEqual(['c1']);
    expect(repo.counts().snoozed).toBe(0); // only inbox-state comments count as snoozed
  });
});

describe('waking', () => {
  it('wakes due snoozes, floats them to the top and reports them', () => {
    repo.snooze(['c4'], at(1));
    expect(repo.wakeSnoozed().woken).toEqual([]);
    advance(hours(2));
    // Past but unswept: already visible in the inbox, not counted as snoozed.
    expect(inboxIds()).toContain('c4');
    expect(repo.counts().snoozed).toBe(0);
    const w = repo.wakeSnoozed();
    expect(w.woken).toEqual(['c4']);
    expect(w.counts.inbox).toBe(4);
    expect(inboxIds()).toEqual(['c4', 'c1', 'c2', 'c3']);
    const top = repo.listInbox({ view: 'inbox' }).items[0]!;
    expect(top).toMatchObject({ snoozedUntil: null, wokeAt: at(1) });
    expect(repo.wakeSnoozed().woken).toEqual([]);
  });

  it('wakes silently for comments no longer in the inbox', () => {
    repo.snooze(['c1'], at(1));
    repo.triage(['c1'], 'done');
    advance(hours(2));
    expect(repo.wakeSnoozed().woken).toEqual([]);
  });

  it('paginates with a cursor on the woke-aware sort value', () => {
    repo.snooze(['c3'], at(1));
    advance(hours(2));
    repo.wakeSnoozed(); // c3 now sorts at at(1), above everything
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = repo.listInbox({ view: 'inbox', limit: 1, cursor });
      all.push(...page.items.map((x) => x.comment.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (i === 0) expect(cursor).toBe(`${at(1)}|c3`);
    }
    expect(all).toEqual(['c3', 'c1', 'c2', 'c4']);
  });
});
