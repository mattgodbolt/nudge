import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { habitsReport, formatHabits, fmtDuration } from './habits.js';
import { openDb, type Db } from './db.js';
import { createEvents } from './events.js';

const T = (m: number) => new Date(Date.parse('2026-11-10T00:00:00.000Z') + m * 60_000).toISOString();

function seed(): Db {
  const db = openDb(':memory:');
  const item = (id: string, provider: string, kind: string, seenMin: number) =>
    db
      .prepare(
        `INSERT INTO items (id, provider, kind, title, occurred_at, state, state_source, state_changed_at, first_seen_at)
         VALUES (?, ?, ?, 'SECRET TITLE', ?, 'inbox', 'sync', ?, ?)`,
      )
      .run(id, provider, kind, T(0), T(0), T(seenMin));
  item('a', 'youtube', 'comment', 0);
  item('b', 'youtube', 'comment', 0);
  item('c', 'youtube', 'comment', 0);
  item('g', 'github', 'pr', 0);
  const ev = createEvents(db);
  const r = ev.record;
  r({ itemId: 'a', at: T(10), kind: 'state', from: 'inbox', to: 'done', source: 'user' });
  r({
    itemId: 'a',
    at: T(10),
    kind: 'decision',
    to: 'done',
    source: 'user',
    meta: { rank: 0, input: 'key', above: [] },
  });
  r({
    itemId: 'c',
    at: T(20),
    kind: 'decision',
    to: 'done',
    source: 'user',
    meta: { rank: 2, input: 'button', above: ['b', 'a'] },
  });
  r({ itemId: 'c', at: T(20), kind: 'state', from: 'inbox', to: 'done', source: 'user' });
  r({ itemId: 'b', at: T(30), kind: 'state', from: 'inbox', to: 'replied', source: 'user' }); // b actioned later
  r({ itemId: 'g', at: T(40), kind: 'snooze', from: null, to: T(100), source: 'user' });
  r({ itemId: 'g', at: T(100), kind: 'snooze', from: T(100), to: null, source: 'auto' });
  r({ itemId: 'g', at: T(110), kind: 'state', from: 'inbox', to: 'done', source: 'user' });
  r({ itemId: 'a', at: T(50), kind: 'open', to: 'inbox', source: 'user', meta: { dwellMs: 2000, input: 'key' } });
  r({ itemId: 'b', at: T(51), kind: 'open', to: 'inbox', source: 'user', meta: { dwellMs: 6000, input: 'key' } });
  r({ itemId: 'c', at: T(52), kind: 'open', to: 'done', source: 'user', meta: { input: 'other' } });
  return db;
}

describe('habitsReport', () => {
  const rep = habitsReport(seed());

  it('summarises the action mix per provider and kind', () => {
    expect(rep.actionMix).toContainEqual({ provider: 'youtube', kind: 'comment', action: 'done', count: 2 });
    expect(rep.actionMix).toContainEqual({ provider: 'youtube', kind: 'comment', action: 'replied', count: 1 });
    expect(rep.actionMix).toContainEqual({ provider: 'github', kind: 'pr', action: 'snooze', count: 1 });
  });

  it('takes the median time to first action per provider', () => {
    // a 10m, c 20m, b 30m -> 20m; g 40m.
    expect(rep.timeToFirstActionMs).toEqual([
      { provider: 'github', items: 1, medianMs: 40 * 60_000 },
      { provider: 'youtube', items: 3, medianMs: 20 * 60_000 },
    ]);
  });

  it('measures snooze return and rank / passed-over behaviour', () => {
    expect(rep.snooze).toEqual({ snoozed: 1, woken: 1, actionedAfterWake: 1 });
    expect(rep.decisions).toMatchObject({ total: 2, rank0: 1, deeper: 1, byInput: { key: 1, button: 1 } });
    // above: b (actioned at T30 > T20), a (actioned at T10 < T20, so left)
    expect(rep.passedOver).toEqual({ pairs: 2, laterActioned: 1, left: 1 });
  });

  it('gives open dwell medians by view', () => {
    expect(rep.openDwell).toEqual([
      { view: 'inbox', opens: 2, withDwell: 2, medianMs: 4000 },
      { view: 'done', opens: 1, withDwell: 0, medianMs: null },
    ]);
  });

  it('prints counts but never item text or ids', () => {
    const text = formatHabits(rep);
    expect(text).toContain('youtube / comment / done: 2');
    expect(text).not.toContain('SECRET');
    expect(text).toContain('at rank 0: 50.0% (1/2)');
  });
});

describe('edge cases', () => {
  it('handles an empty event table', () => {
    const r = habitsReport(openDb(':memory:'));
    expect(r.events).toBe(0);
    expect(formatHabits(r)).toContain('Nothing recorded yet');
  });

  it('throws a recognisable error on a database without item_events', () => {
    const raw = new Database(':memory:');
    expect(() => habitsReport(raw as unknown as Db)).toThrow(/no such table/i);
  });

  it('formats durations', () => {
    expect(fmtDuration(null)).toBe('n/a');
    expect(fmtDuration(450)).toBe('450ms');
    expect(fmtDuration(90_000)).toBe('1.5m');
  });
});

describe('snooze context', () => {
  it('counts GitHub snoozes by latest commenter, comment bucket and kind', () => {
    const db = openDb(':memory:');
    const item = (id: string, kind: string) =>
      db
        .prepare(
          `INSERT INTO items (id, provider, kind, title, occurred_at, state, state_source, state_changed_at, first_seen_at)
           VALUES (?, 'github', ?, 't', ?, 'inbox', 'sync', ?, ?)`,
        )
        .run(id, kind, T(0), T(0), T(0));
    for (const [id, k] of [
      ['g1', 'pr'],
      ['g2', 'pr'],
      ['g3', 'issue'],
      ['g4', 'issue'],
      ['g5', 'pr'],
    ] as const)
      item(id, k);
    const r = createEvents(db).record;
    const snooze = (itemId: string, meta?: Record<string, unknown>) =>
      r({ itemId, at: T(5), kind: 'snooze', from: null, to: T(100), source: 'user', ...(meta ? { meta } : {}) });
    snooze('g1', { lastCommenter: 'me', lastCommenterIsMe: true, comments: 2, itemKind: 'pr' });
    snooze('g2', { lastCommenter: 'bob', lastCommenterIsMe: false, comments: 9, itemKind: 'pr' });
    snooze('g3', { lastCommenter: null, lastCommenterIsMe: false, comments: 0, itemKind: 'issue' });
    snooze('g4'); // lookup failed or never ran
    snooze('g5', { lastCommenter: 'bob', lastCommenterIsMe: false, comments: 1, itemKind: 'pr' });
    const rep = habitsReport(db);
    expect(rep.snoozeContext).toEqual({
      byLastCommenter: { mine: 1, theirs: 2, unknown: 2 },
      byComments: { '0': 1, '1-3': 2, '4+': 1, unknown: 1 },
      byItemKind: { pr: 3, issue: 2 },
    });
    expect(rep.snooze.snoozed).toBe(5);
    const text = formatHabits(rep);
    expect(text).toContain('Snooze context (GitHub snoozes: 5)');
    expect(text).toContain('latest comment: mine 1, theirs 2, unknown 2');
    expect(text).not.toContain('bob');
  });

  it('counts a GitHub snooze with no recorded context as unknown', () => {
    expect(habitsReport(seed()).snoozeContext.byLastCommenter).toEqual({ mine: 0, theirs: 0, unknown: 1 });
  });
});

describe('snoozing until activity', () => {
  function world() {
    const db = openDb(':memory:');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      db.prepare(
        `INSERT INTO items (id, provider, kind, title, occurred_at, state, state_source, state_changed_at, first_seen_at)
         VALUES (?, 'github', 'pr', 'SECRET', ?, 'inbox', 'sync', ?, ?)`,
      ).run(id, T(0), T(0), T(0));
    }
    const r = createEvents(db).record;
    const snooze = (itemId: string, min: number, meta: Record<string, unknown>) =>
      r({ itemId, at: T(min), kind: 'snooze', from: null, to: T(min + 9999), source: 'user', meta });
    const wake = (itemId: string, min: number, meta: Record<string, unknown>) =>
      r({
        itemId,
        at: T(min),
        kind: 'snooze',
        from: T(min),
        to: null,
        source: 'auto',
        meta: { reason: 'wake', ...meta },
      });
    // a: waited on them, activity after 60 min. b: waited on them, nothing for 7 days, then the owner marked it done.
    // c: waited on merge, nothing, then dismissed. d: in flight, nothing, snoozed again. e: until activity, unsnoozed by hand.
    snooze('a', 0, { bucket: 'waiting_on_them', untilActivity: true });
    wake('a', 60, { cause: 'activity', untilActivity: true });
    snooze('b', 0, { bucket: 'waiting_on_them', untilActivity: true });
    wake('b', 7 * 1440, { cause: 'fallback', untilActivity: true });
    r({
      itemId: 'b',
      at: T(7 * 1440 + 5),
      kind: 'state',
      from: 'inbox',
      to: 'done',
      source: 'user',
      meta: { reason: 'done' },
    });
    snooze('c', 0, { bucket: 'waiting_on_merge', untilActivity: true });
    wake('c', 3 * 1440, { cause: 'fallback', untilActivity: true });
    r({
      itemId: 'c',
      at: T(3 * 1440 + 1),
      kind: 'state',
      from: 'inbox',
      to: 'done',
      source: 'user',
      meta: { reason: 'no_action' },
    });
    snooze('d', 0, { bucket: 'in_flight', untilActivity: true });
    wake('d', 7 * 1440, { cause: 'fallback', untilActivity: true });
    snooze('d', 7 * 1440 + 2, { bucket: 'in_flight', untilActivity: true });
    snooze('e', 0, { untilActivity: true });
    r({ itemId: 'e', at: T(30), kind: 'snooze', from: T(9999), to: null, source: 'user', meta: { cause: 'manual' } });
    wake('a', 99999, {}); // a plain timed wake carries no cause and is not counted
    return habitsReport(db);
  }

  it('counts snoozes by bucket, how the waits ended, how long they took, and what the owner did after a fallback', () => {
    const sb = world().snoozeBuckets;
    expect(sb.byBucket).toEqual({ waiting_on_them: 2, waiting_on_merge: 1, in_flight: 2, none: 1 });
    expect(sb.untilActivity).toBe(6);
    expect(sb.wakeCauses).toEqual({ activity: 1, fallback: 3, manual: 1 });
    expect(sb.medianMsToWake).toEqual({
      activity: 60 * 60_000,
      fallback: 7 * 86_400_000,
      manual: 30 * 60_000,
    });
    expect(sb.afterFallback).toEqual({ done: 1, dismissed: 1, resnoozed: 1, other: 0, none: 0 });
  });

  it('prints them without any item text', () => {
    const text = formatHabits(world());
    expect(text).toContain('Snoozes by bucket: waiting_on_them 2');
    expect(text).toContain(
      'activity 20.0% (1/5), fallback with no activity 60.0% (3/5), unsnoozed by hand 20.0% (1/5)',
    );
    expect(text).toContain('median time to wake: activity 1.0h, fallback 7.0d, manual 30.0m');
    expect(text).toContain('after a fallback wake you: done 1, dismissed 1, resnoozed 1');
    expect(text).not.toContain('SECRET');
  });

  it('is all zeros when nothing was ever parked until activity', () => {
    expect(habitsReport(seed()).snoozeBuckets).toMatchObject({
      byBucket: { none: 1 },
      untilActivity: 0,
      wakeCauses: { activity: 0, fallback: 0, manual: 0 },
      medianMsToWake: { activity: null, fallback: null, manual: null },
    });
  });
});
