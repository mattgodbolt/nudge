import { beforeEach, describe, expect, it } from 'vitest';
import type { GithubItemUpsert, Repo, YtComment } from '../contracts.js';
import { githubItemId } from './feeds.js';
import { openDb, type Db } from './db.js';
import { createRepo } from './repo.js';
import { githubPr, orgFeed, prId } from './test-fixtures.js';

const OWN_CHANNEL = 'UC' + 'o'.repeat(22);
const DAY = 86_400_000;
let t = Date.parse('2026-11-12T10:00:00.000Z');
let db: Db;
let repo: Repo;
const pr = githubPr;
const later = (ms: number) => new Date(t + ms).toISOString();
const item = (itemId: string) => repo.listInbox({ view: 'all' }).items.find((i) => i.item.id === itemId)!;
const gh = (n: number) => item(prId(n));
const events = (itemId: string) =>
  (
    db
      .prepare("SELECT source, to_value, meta FROM item_events WHERE item_id = ? AND kind = 'snooze' ORDER BY id")
      .all(itemId) as { source: string; to_value: string | null; meta: string | null }[]
  ).map((r) => ({ source: r.source, to: r.to_value, ...(r.meta ? JSON.parse(r.meta) : {}) }));
let feedId: number;

beforeEach(() => {
  t = Date.parse('2026-11-12T10:00:00.000Z');
  db = openDb(':memory:');
  repo = createRepo(db, () => new Date(t));
  feedId = orgFeed(repo).id;
  repo.upsertGithubItems(feedId, [pr(1), pr(2), pr(3)]);
  repo.updateSettings({ github: { token: null, myAccounts: ['me'] } });
});

describe('snoozing with a bucket, until activity', () => {
  it('stores the bucket and the flag, shows them while snoozed, and records both on the event', () => {
    const r = repo.snooze([prId(1)], later(7 * DAY), 'waiting for the author', {
      bucket: 'waiting_on_them',
      untilActivity: true,
    });
    expect(gh(1)).toMatchObject({
      snoozedUntil: later(7 * DAY),
      snoozeBucket: 'waiting_on_them',
      snoozeUntilActivity: true,
      snoozedAt: later(0),
      wakeCause: null,
      snoozeNag: null,
    });
    expect(events(prId(1))[0]).toMatchObject({
      source: 'user',
      actionId: r.actionId,
      bucket: 'waiting_on_them',
      untilActivity: true,
    });
  });

  it('keeps a plain timed snooze exactly as before: no bucket, no flag, nothing extra on the event', () => {
    repo.snooze([prId(1)], later(DAY));
    expect(gh(1)).toMatchObject({ snoozeBucket: null, snoozeUntilActivity: false });
    expect(Object.keys(events(prId(1))[0]!).sort()).toEqual(['actionId', 'source', 'to']);
  });

  it('allows a bucket without waiting on activity (a timed snooze for a reason)', () => {
    repo.snooze([prId(1)], later(DAY), null, { bucket: 'in_flight' });
    expect(gh(1)).toMatchObject({ snoozeBucket: 'in_flight', snoozeUntilActivity: false });
  });

  it('applies one choice to every item of a bulk snooze', () => {
    const r = repo.snooze([prId(1), prId(2), prId(3)], later(3 * DAY), 'merge first', {
      bucket: 'waiting_on_merge',
      untilActivity: true,
    });
    expect(r.changes).toHaveLength(3);
    for (const n of [1, 2, 3]) {
      expect(gh(n)).toMatchObject({
        snoozeBucket: 'waiting_on_merge',
        snoozeUntilActivity: true,
        snoozeWhy: 'merge first',
      });
      expect(events(prId(n))[0]).toMatchObject({
        actionId: r.actionId,
        bucket: 'waiting_on_merge',
        untilActivity: true,
      });
    }
  });

  it('treats the same time with a different bucket as a change, and the same everything as none', () => {
    repo.snooze([prId(1)], later(DAY), null, { bucket: 'in_flight' });
    expect(repo.snooze([prId(1)], later(DAY), null, { bucket: 'in_flight' }).actionId).toBeNull();
    expect(repo.snooze([prId(1)], later(DAY), null, { bucket: 'lower_priority' }).actionId).not.toBeNull();
    expect(gh(1).snoozeBucket).toBe('lower_priority');
  });

  it('puts back the previous reason, bucket, mode and start on undo', () => {
    repo.snooze([prId(1)], later(2 * DAY), 'first reason', { bucket: 'in_flight' });
    t += 60_000;
    const second = repo.snooze([prId(1)], later(9 * DAY), 'second', { bucket: 'waiting_on_them', untilActivity: true });
    expect(gh(1)).toMatchObject({ snoozeBucket: 'waiting_on_them', snoozeUntilActivity: true, snoozeWhy: 'second' });
    repo.undoSnooze(second.actionId!);
    expect(gh(1)).toMatchObject({
      snoozedUntil: new Date(Date.parse('2026-11-12T10:00:00.000Z') + 2 * DAY).toISOString(),
      snoozeBucket: 'in_flight',
      snoozeUntilActivity: false,
      snoozeWhy: 'first reason',
      snoozedAt: '2026-11-12T10:00:00.000Z',
    });
  });

  it('undoing a first snooze leaves the item unparked with no bucket', () => {
    const r = repo.snooze([prId(1)], later(DAY), 'why', { bucket: 'in_flight', untilActivity: true });
    repo.undoSnooze(r.actionId!);
    expect(gh(1)).toMatchObject({
      snoozedUntil: null,
      snoozeBucket: null,
      snoozeUntilActivity: false,
      snoozeWhy: null,
    });
  });

  it('records a manual unsnooze as cause manual, ends the wait, and undoing it brings the wait back', () => {
    repo.snooze([prId(1)], later(DAY), null, { bucket: 'waiting_on_them', untilActivity: true });
    const un = repo.snooze([prId(1)], null);
    expect(events(prId(1)).at(-1)).toMatchObject({ source: 'user', to: null, cause: 'manual' });
    expect(gh(1)).toMatchObject({ snoozedUntil: null, snoozeUntilActivity: false, snoozeNag: null });
    repo.undoSnooze(un.actionId!);
    expect(gh(1)).toMatchObject({ snoozeUntilActivity: true, snoozeBucket: 'waiting_on_them' });
  });

  it('also records manual when the owner moves a snoozed item back to the inbox', () => {
    repo.snooze([prId(1)], later(DAY), null, { untilActivity: true });
    repo.triage([prId(1)], 'inbox');
    expect(events(prId(1)).at(-1)).toMatchObject({ to: null, cause: 'manual', via: 'triage' });
    expect(gh(1).snoozeUntilActivity).toBe(false);
  });
});

describe('assigning a bucket afterwards', () => {
  it('stores it once for the snooze that asked, and notes on the event that it was automatic', () => {
    const r = repo.snooze([prId(1)], later(DAY), 'wait for the reporter to answer');
    expect(repo.assignSnoozeBucket(prId(1), r.actionId!, 'waiting_on_them')).toBe(true);
    expect(gh(1).snoozeBucket).toBe('waiting_on_them');
    expect(events(prId(1))[0]).toMatchObject({ bucket: 'waiting_on_them', bucketAuto: true });
    expect(repo.assignSnoozeBucket(prId(1), r.actionId!, 'in_flight')).toBe(false); // already has one
  });

  it('does nothing when the snooze has changed or ended since', () => {
    const r = repo.snooze([prId(1)], later(DAY), 'x');
    repo.snooze([prId(1)], later(2 * DAY), 'y');
    expect(repo.assignSnoozeBucket(prId(1), r.actionId!, 'in_flight')).toBe(false);
    const r2 = repo.snooze([prId(2)], later(DAY), 'x');
    repo.undoSnooze(r2.actionId!);
    expect(repo.assignSnoozeBucket(prId(2), r2.actionId!, 'in_flight')).toBe(false);
    expect(gh(2).snoozeBucket).toBeNull();
  });
});

describe('the fallback date', () => {
  it('wakes an until-activity snooze with cause fallback and marks it as an audit nag', () => {
    repo.snooze([prId(1)], later(7 * DAY), 'waiting', { bucket: 'waiting_on_them', untilActivity: true });
    t += 7 * DAY + 1000;
    expect(repo.wakeSnoozed().woken).toEqual([prId(1)]);
    expect(gh(1)).toMatchObject({
      snoozedUntil: null,
      wakeCause: 'fallback',
      snoozeBucket: 'waiting_on_them',
      snoozeNag: { bucket: 'waiting_on_them', days: 7 },
    });
    expect(events(prId(1)).at(-1)).toMatchObject({
      source: 'auto',
      to: null,
      reason: 'wake',
      cause: 'fallback',
      untilActivity: true,
      bucket: 'waiting_on_them',
    });
    expect(repo.snoozeNag(prId(1))).toEqual({ bucket: 'waiting_on_them', days: 7, why: 'waiting' });
  });

  it('wakes a plain timed snooze with no cause and no audit nag', () => {
    repo.snooze([prId(1)], later(DAY), null, { bucket: 'in_flight' });
    t += DAY + 1000;
    repo.wakeSnoozed();
    expect(gh(1)).toMatchObject({ wakeCause: null, snoozeNag: null, snoozeBucket: 'in_flight' });
    expect(events(prId(1)).at(-1)).toEqual({ source: 'auto', to: null, reason: 'wake' });
  });

  it('snoozing again clears the nag, and the bucket can stay the same', () => {
    repo.snooze([prId(1)], later(DAY), null, { bucket: 'waiting_on_them', untilActivity: true });
    t += DAY + 1000;
    repo.wakeSnoozed();
    expect(gh(1).snoozeNag).not.toBeNull();
    repo.snooze([prId(1)], later(7 * DAY), null, { bucket: 'waiting_on_them', untilActivity: true });
    expect(gh(1)).toMatchObject({ snoozeNag: null, wakeCause: null });
  });

  it('is undoable: undoing the re-snooze brings the audit nag back', () => {
    repo.snooze([prId(1)], later(DAY), null, { bucket: 'waiting_on_them', untilActivity: true });
    t += DAY + 1000;
    repo.wakeSnoozed();
    const again = repo.snooze([prId(1)], later(7 * DAY), null, { bucket: 'waiting_on_them', untilActivity: true });
    repo.undoSnooze(again.actionId!);
    expect(gh(1).snoozeNag).toMatchObject({ bucket: 'waiting_on_them' });
  });
});

describe('undoing a move back to the inbox that cleared a snooze', () => {
  const HOUR = 3_600_000;
  const undos = (itemId: string) =>
    (
      db
        .prepare("SELECT from_value, to_value, meta FROM item_events WHERE item_id = ? AND kind = 'undo' ORDER BY id")
        .all(itemId) as { from_value: string | null; to_value: string | null; meta: string }[]
    ).map((r) => ({ from: r.from_value, to: r.to_value, ...JSON.parse(r.meta) }));
  const snoozeEventId = (itemId: string, actionId: number) =>
    (
      db
        .prepare(
          "SELECT id FROM item_events WHERE item_id = ? AND kind = 'snooze' AND json_extract(meta, '$.actionId') = ?",
        )
        .get(itemId, actionId) as { id: number }
    ).id;

  it('puts the snooze back on an item that was already in the inbox (a bulk move from All)', () => {
    repo.snooze([prId(1)], later(7 * DAY), 'waiting for carol', { bucket: 'waiting_on_them', untilActivity: true });
    repo.triage([prId(2)], 'done');
    t += 60_000;
    const back = repo.triage([prId(1), prId(2)], 'inbox');
    // Only the done item changes state; the snoozed one just loses its snooze.
    expect(back.changes).toEqual([{ commentId: prId(2), from: 'done', to: 'inbox' }]);
    expect(gh(1)).toMatchObject({ snoozedUntil: null, snoozeUntilActivity: false });

    const u = repo.undo(back.actionId);
    expect(u.changes).toEqual([{ commentId: prId(2), from: 'inbox', to: 'done' }]);
    expect(gh(1)).toMatchObject({
      comment: expect.objectContaining({ state: 'inbox' }),
      snoozedUntil: '2026-11-19T10:00:00.000Z',
      snoozeUntilActivity: true,
      snoozeBucket: 'waiting_on_them',
      snoozeWhy: 'waiting for carol',
      snoozedAt: '2026-11-12T10:00:00.000Z',
    });
    expect(gh(2).comment.state).toBe('done');
    expect(u.counts.snoozed).toBe(1);
    // The history compensates the triage's unsnooze, pointing at it, and adds no state undo for the unmoved item.
    expect(undos(prId(1))).toEqual([
      {
        from: null,
        to: '2026-11-19T10:00:00.000Z',
        actionId: back.actionId,
        original: 'snooze',
        originalEventId: snoozeEventId(prId(1), back.actionId),
      },
    ]);
  });

  it('puts back both the state and the snooze of a snoozed item that had been marked done', () => {
    repo.snooze([prId(1)], later(3 * DAY), null, { bucket: 'in_flight' });
    repo.triage([prId(1)], 'done');
    const back = repo.triage([prId(1)], 'inbox');
    expect(back.changes).toEqual([{ commentId: prId(1), from: 'done', to: 'inbox' }]);
    repo.undo(back.actionId);
    expect(gh(1)).toMatchObject({ comment: expect.objectContaining({ state: 'done' }), snoozeBucket: 'in_flight' });
    expect(db.prepare('SELECT snoozed_until FROM items WHERE id = ?').get(prId(1))).toEqual({
      snoozed_until: later(3 * DAY),
    });
    expect(undos(prId(1)).map((e) => e.original)).toEqual(['state', 'snooze']);
  });

  it('restores a snooze that has run out since as ended, so it wakes as it would have', () => {
    repo.snooze([prId(1)], later(HOUR), null, { bucket: 'waiting_on_them', untilActivity: true });
    const back = repo.triage([prId(1)], 'inbox');
    t += 2 * HOUR;
    repo.undo(back.actionId);
    // Past its date: not snoozed, still in the inbox, and the waker ends it with the audit nag it would have had.
    expect(gh(1)).toMatchObject({ snoozedUntil: null, comment: expect.objectContaining({ state: 'inbox' }) });
    expect(repo.listInbox({ view: 'inbox' }).items.map((i) => i.item.id)).toContain(prId(1));
    expect(repo.wakeSnoozed().woken).toEqual([prId(1)]);
    expect(gh(1)).toMatchObject({ wakeCause: 'fallback', snoozeNag: { bucket: 'waiting_on_them' } });
    expect(db.prepare('SELECT woke_at FROM items WHERE id = ?').get(prId(1))).toEqual({ woke_at: later(-HOUR) });
  });

  it('does not resurrect a snooze the owner has changed since', () => {
    repo.snooze([prId(1), prId(2)], later(DAY));
    const back = repo.triage([prId(1), prId(2)], 'inbox');
    t += 60_000;
    repo.snooze([prId(1)], later(5 * DAY));
    repo.snooze([prId(2)], later(5 * DAY));
    repo.snooze([prId(2)], null);
    repo.undo(back.actionId);
    expect(gh(1).snoozedUntil).toBe(later(5 * DAY));
    expect(gh(2).snoozedUntil).toBeNull();
    expect(undos(prId(1))).toEqual([]);
    expect(undos(prId(2))).toEqual([]);
  });

  it('undoes in order: undoing a later snooze first, then the move, brings the first snooze back', () => {
    repo.snooze([prId(1)], later(DAY));
    const back = repo.triage([prId(1)], 'inbox');
    const again = repo.snooze([prId(1)], later(5 * DAY));
    repo.undoSnooze(again.actionId!);
    repo.undo(back.actionId);
    expect(gh(1).snoozedUntil).toBe(later(DAY));
  });

  it('still undoes an action recorded before snoozes were kept', () => {
    repo.triage([prId(1)], 'done');
    const r = db
      .prepare("INSERT INTO triage_actions (created_at, to_state, changes) VALUES (?, 'inbox', ?)")
      .run(later(0), JSON.stringify([{ commentId: prId(1), from: 'done', fromSource: 'user', fromReason: null }]));
    db.prepare("UPDATE items SET state = 'inbox' WHERE id = ?").run(prId(1));
    const u = repo.undo(Number(r.lastInsertRowid));
    expect(u.changes).toEqual([{ commentId: prId(1), from: 'inbox', to: 'done' }]);
  });
});

describe('waking on GitHub activity', () => {
  const park = (n: number) =>
    repo.snooze([prId(n)], later(7 * DAY), 'waiting', { bucket: 'waiting_on_them', untilActivity: true });

  it('wakes when someone else comments, with cause activity, a wake time, and the new comments marked', () => {
    park(1);
    t += 3600_000;
    const res = repo.upsertGithubItems(feedId, [
      pr(1, { comments: 2, lastCommenter: 'carol', lastCommenterIsMe: false }),
    ]);
    expect(res.woken).toEqual([prId(1)]);
    expect(res.reopened).toEqual([]);
    expect(gh(1)).toMatchObject({
      snoozedUntil: null,
      wokeAt: later(0),
      wakeCause: 'activity',
      snoozeNag: null,
      snoozeBucket: 'waiting_on_them',
    });
    expect(gh(1).item.reason).toBe('new_activity');
    expect(gh(1).item.github?.activitySince).not.toBeNull();
    expect(events(prId(1)).at(-1)).toMatchObject({
      source: 'auto',
      to: null,
      reason: 'wake',
      cause: 'activity',
      untilActivity: true,
      bucket: 'waiting_on_them',
      trigger: 'comment',
    });
  });

  it('wakes a parked PR on a review from someone else, recorded as a review', () => {
    park(1);
    t += 3600_000;
    const res = repo.upsertGithubItems(feedId, [pr(1, { updatedAt: later(0), reviewer: 'dave' })]);
    expect(res.woken).toEqual([prId(1)]);
    expect(gh(1)).toMatchObject({ wakeCause: 'activity', snoozedUntil: null });
    expect(gh(1).item.github?.lastCommenter).toBe('dave');
    expect(events(prId(1)).at(-1)).toMatchObject({ cause: 'activity', trigger: 'review' });
  });

  it('does not wake on the owner own comment, but a later comment from someone else does', () => {
    park(1);
    expect(
      repo.upsertGithubItems(feedId, [pr(1, { comments: 1, lastCommenter: 'Me', lastCommenterIsMe: true })]).woken,
    ).toEqual([]);
    expect(gh(1)).toMatchObject({ snoozeUntilActivity: true, snoozedUntil: later(7 * DAY) });
    expect(
      repo.upsertGithubItems(feedId, [pr(1, { comments: 2, lastCommenter: 'carol', lastCommenterIsMe: false })]).woken,
    ).toEqual([prId(1)]);
  });

  it('wakes on closed or merged, keeps it in the inbox, and the next poll does not file it away', () => {
    park(1);
    const res = repo.upsertGithubItems(feedId, [pr(1, { sourceState: 'merged' })]);
    expect(res.woken).toEqual([prId(1)]);
    expect(gh(1)).toMatchObject({ wakeCause: 'activity' });
    expect(gh(1).comment.state).toBe('inbox');
    expect(events(prId(1)).at(-1)).toMatchObject({ trigger: 'merged' });
    repo.upsertGithubItems(feedId, [pr(1, { sourceState: 'merged' })]);
    expect(gh(1).comment.state).toBe('inbox');
  });

  it('does not wake an ordinary timed snooze, which keeps its date', () => {
    repo.snooze([prId(2)], later(DAY));
    const res = repo.upsertGithubItems(feedId, [
      pr(2, { comments: 3, lastCommenter: 'carol', lastCommenterIsMe: false }),
    ]);
    expect(res.woken).toEqual([]);
    expect(gh(2).snoozedUntil).toBe(later(DAY));
  });

  it('stays parked while who commented is unknown (the lookup failed), and wakes once it is known; tells the poller which items need a lookup', () => {
    park(1);
    expect(repo.githubItemMeta([prId(1), prId(2)]).get(prId(1))?.snoozedUntilActivity).toBe(true);
    expect(repo.githubItemMeta([prId(1), prId(2)]).get(prId(2))?.snoozedUntilActivity).toBe(false);
    expect(repo.upsertGithubItems(feedId, [pr(1, { comments: 1 })]).woken).toEqual([]);
    expect(
      repo.upsertGithubItems(feedId, [pr(1, { comments: 1, lastCommenter: 'carol', lastCommenterIsMe: false })]).woken,
    ).toEqual([prId(1)]);
  });

  it('clears the "no activity" mark when someone then comments on an item that already came back', () => {
    repo.snooze([prId(1)], later(DAY), null, { bucket: 'waiting_on_them', untilActivity: true });
    t += DAY + 1000;
    repo.wakeSnoozed();
    expect(gh(1).snoozeNag).not.toBeNull();
    repo.upsertGithubItems(feedId, [pr(1, { comments: 1, lastCommenter: 'carol', lastCommenterIsMe: false })]);
    expect(gh(1)).toMatchObject({ snoozeNag: null, wakeCause: null });
  });

  it('does not wake a snoozed item that was muted', () => {
    park(1);
    repo.addMuteRule('item', prId(1));
    expect(repo.upsertGithubItems(feedId, [pr(1, { comments: 1 })]).woken).toEqual([]);
  });
});

describe('waking on a YouTube reply', () => {
  const when = (min: number) => new Date(t + min * 60_000).toISOString();
  const yt = (cid: string, parent: string | null, min: number, channel = 'UCviewer'): YtComment => ({
    id: cid,
    parentId: parent,
    videoId: 'v1',
    authorName: 'A',
    authorChannelId: channel,
    authorAvatarUrl: null,
    textHtml: cid,
    likeCount: 0,
    publishedAt: when(min),
    updatedAt: when(min),
  });
  const thread = (replies: YtComment[]) => ({
    id: 'top',
    videoId: 'v1',
    channelId: 'UCchan',
    canReply: true,
    totalReplyCount: replies.length,
    replies,
    topComment: yt('top', null, -120),
  });
  beforeEach(() => {
    const s = repo.addSource({
      kind: 'playlist',
      ytId: 'PL',
      title: 'P',
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.setSourceVideos(s.id, [{ id: 'v1', position: 0 }]);
    repo.upsertThread(thread([]));
    repo.snooze(['top'], later(7 * DAY), 'waiting', { bucket: 'waiting_on_them', untilActivity: true });
  });
  const parked = () => repo.listInbox({ view: 'all' }).items.find((i) => i.comment.id === 'top')!;

  it('wakes on a new reply from someone else, with cause activity', () => {
    t += 10 * 60_000;
    const r = repo.upsertThread(thread([yt('r1', 'top', 5)]));
    expect(r.wokenIds).toEqual(['top']);
    expect(parked()).toMatchObject({ snoozedUntil: null, wakeCause: 'activity', wokeAt: later(0) });
    expect(events('top').at(-1)).toMatchObject({ source: 'auto', cause: 'activity', trigger: 'reply' });
  });

  it('wakes when the reply arrives through addReplies', () => {
    repo.upsertThread(thread([]));
    t += 10 * 60_000;
    expect(repo.addReplies('top', [yt('r1', 'top', 5)]).wokenIds).toEqual(['top']);
  });

  it("does not wake on the owner's own reply", () => {
    repo.updateSettings({ ownChannelIds: [OWN_CHANNEL] });
    t += 10 * 60_000;
    const r = repo.upsertThread(thread([yt('r1', 'top', 5, OWN_CHANNEL)]));
    expect(r.wokenIds).toEqual([]);
  });

  it('does not wake on a reply older than the snooze (an old reply turning up in a backfill)', () => {
    t += 10 * 60_000;
    expect(repo.upsertThread(thread([yt('old', 'top', -60)])).wokenIds).toEqual([]);
    expect(parked().snoozedUntil).not.toBeNull();
  });

  it('does not wake an ordinary timed snooze', () => {
    repo.snooze(['top'], later(7 * DAY));
    t += 10 * 60_000;
    expect(repo.upsertThread(thread([yt('r1', 'top', 5)])).wokenIds).toEqual([]);
  });
});
