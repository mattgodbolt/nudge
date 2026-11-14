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
