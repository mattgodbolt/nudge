import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { InsightCard, Insights, InsightsRange } from '../../shared/insights.js';
import { openDb, type Db } from './db.js';
import { createInsightsReader, emptyInsights, insightsReport, LIVE_LAG_MS, MIN } from './insights.js';
import { inboxCountByDay } from './replay.js';
import { localClock } from './history.js';
import { MIGRATIONS } from './migrations.js';
import { createRepo } from './repo.js';

// Fixtures are written straight into the tables, like habits.test.ts: the report reads history, so each test says
// exactly what happened and when. NOW is Monday 2026-11-16 12:00 UTC.
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (t: number) => new Date(t).toISOString();
const ago = (days: number, hours = 0) => NOW - days * DAY + hours * HOUR;

interface ItemOpts {
  provider?: string;
  kind?: string;
  seen?: number;
  occurred?: number;
  state?: string;
  isOwn?: boolean;
  muted?: boolean;
  container?: string | null;
  containerTitle?: string | null;
  title?: string | null;
  author?: string | null;
  data?: Record<string, unknown> | null;
  body?: string;
  snoozedUntil?: number | null;
  snoozedAt?: number | null;
  bucket?: string | null;
  wokeAt?: number | null;
}

function fixture(db: Db = openDb(':memory:')) {
  let actionId = 1000;
  const f = {
    db,
    item(id: string, o: ItemOpts = {}) {
      const seen = o.seen ?? ago(1);
      db.prepare(
        `INSERT INTO items (id, provider, kind, container_key, container_title, title, author, is_own, body_plain,
           occurred_at, data, state, state_source, state_changed_at, first_seen_at, muted, snoozed_until, snoozed_at,
           snooze_bucket, woke_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        o.provider ?? 'github',
        o.kind ?? 'pr',
        o.container === undefined ? 'org/app' : o.container,
        o.containerTitle ?? null,
        o.title === undefined ? `Title ${id}` : o.title,
        o.author === undefined ? 'carol' : o.author,
        o.isOwn ? 1 : 0,
        o.body ?? 'SECRET BODY TEXT',
        iso(o.occurred ?? seen - 60_000),
        o.data === undefined ? JSON.stringify({ comments: 0 }) : o.data === null ? null : JSON.stringify(o.data),
        o.state ?? 'inbox',
        iso(seen),
        iso(seen),
        o.muted ? 1 : 0,
        o.snoozedUntil == null ? null : iso(o.snoozedUntil),
        o.snoozedAt == null ? null : iso(o.snoozedAt),
        o.bucket ?? null,
        o.wokeAt == null ? null : iso(o.wokeAt),
      );
      return id;
    },
    ev(
      item: string,
      at: number,
      kind: string,
      o: { from?: string | null; to?: string | null; source?: string; meta?: Record<string, unknown> } = {},
    ): number {
      return Number(
        db
          .prepare(
            `INSERT INTO item_events (item_id, at, kind, from_value, to_value, source, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item,
            iso(at),
            kind,
            o.from ?? null,
            o.to ?? null,
            o.source ?? 'user',
            o.meta ? JSON.stringify(o.meta) : null,
          ).lastInsertRowid,
      );
    },
    /** One-at-a-time actions, each with its own action id (as triage writes them). */
    done(item: string, at: number, meta: Record<string, unknown> = {}) {
      return f.ev(item, at, 'state', {
        from: 'inbox',
        to: 'done',
        meta: { actionId: actionId++, reason: 'done', ...meta },
      });
    },
    dismiss(item: string, at: number, meta: Record<string, unknown> = {}) {
      return f.ev(item, at, 'state', {
        from: 'inbox',
        to: 'done',
        meta: { actionId: actionId++, reason: 'no_action', ...meta },
      });
    },
    legacy(item: string, at: number, meta: Record<string, unknown> = {}) {
      return f.ev(item, at, 'state', { from: 'inbox', to: 'done', meta: { actionId: actionId++, ...meta } });
    },
    replied(item: string, at: number, meta: Record<string, unknown> = {}) {
      return f.ev(item, at, 'state', { from: 'inbox', to: 'replied', meta: { actionId: actionId++, ...meta } });
    },
    snooze(item: string, at: number, until: number, meta: Record<string, unknown> = {}) {
      return f.ev(item, at, 'snooze', { to: iso(until), meta: { actionId: actionId++, ...meta } });
    },
    /** One action over several items: a bulk action. */
    bulkDone(items: string[], at: number) {
      const a = actionId++;
      for (const i of items) f.ev(i, at, 'state', { from: 'inbox', to: 'done', meta: { actionId: a, reason: 'done' } });
    },
    report(range: InsightsRange = '30d', tz = 'UTC', now = NOW): Insights {
      return insightsReport(db, { range, tz, now: new Date(now) });
    },
  };
  return f;
}

/** Every card in the report, by group and name. */
function cards(r: Insights): [string, InsightCard<unknown>][] {
  const out: [string, InsightCard<unknown>][] = [];
  for (const g of ['rhythm', 'responses', 'predictions', 'sources', 'backlog', 'extras'] as const) {
    for (const [k, c] of Object.entries(r[g])) out.push([`${g}.${k}`, c as InsightCard<unknown>]);
  }
  return out;
}

/** n live GitHub arrivals at the given moments. */
const arrivals = (f: ReturnType<typeof fixture>, times: number[], o: ItemOpts = {}) =>
  times.map((t, i) => f.item(`${o.provider ?? 'gh'}-${i}-${t}`, { seen: t, ...o }));

describe('nothing to say', () => {
  it('an empty database: every card is empty, nothing throws, and the sentence is kind', () => {
    const f = fixture();
    for (const range of ['7d', '30d', '90d', 'all'] as const) {
      for (const tz of ['UTC', 'Europe/London', 'America/Los_Angeles']) {
        const r = f.report(range, tz);
        expect(r.empty).toBe(true);
        for (const [name, c] of cards(r)) expect(c.data, name).toBeNull();
      }
    }
    expect(f.report('7d').sentence).toBe('A quiet week. Lovely.');
    expect(f.report('all').sentence).toBe('All quiet so far. Lovely.');
  });

  it('a database from before migration 11 (no suggestions, no snooze columns): every card empty, no throw', () => {
    const db = new Database(':memory:') as unknown as Db;
    db.exec(MIGRATIONS.slice(0, 10).join('\n'));
    db.pragma('user_version = 10');
    db.prepare(
      `INSERT INTO items (id, provider, kind, occurred_at, state, state_source, state_changed_at, first_seen_at)
       VALUES ('a', 'github', 'pr', ?, 'inbox', 'sync', ?, ?)`,
    ).run(iso(ago(2)), iso(ago(2)), iso(ago(2)));
    const r = insightsReport(db, { range: '30d', tz: 'UTC', now: new Date(NOW) });
    for (const [name, c] of cards(r)) expect(c.data, name).toBeNull();
    expect(r).toEqual(emptyInsights({ range: '30d', tz: 'UTC', now: new Date(NOW) }));
  });

  it('a tiny database: says how far each card is from its minimum, and still shows the backlog', () => {
    const f = fixture();
    f.item('a', { seen: ago(2), state: 'done' });
    f.item('b', { seen: ago(1) });
    f.done('a', ago(1));
    const r = f.report();
    expect(r.empty).toBe(false);
    expect(r.rhythm.arrivals).toEqual({ n: 2, min: 50, data: null });
    expect(r.rhythm.actions).toEqual({ n: 1, min: 50, data: null });
    expect(r.responses.outcomes).toMatchObject({ n: 1, min: 20, data: null });
    expect(r.backlog.inboxAge.data?.bands.find((b) => b.band === '1-7d')?.n).toBe(1);
    expect(r.backlog.elder.data).toMatchObject({ itemId: 'b', label: 'org/app: Title b' });
    expect(r.extras.busiestDay.data).toEqual({ day: '2026-11-15', actions: 1 });
    expect(r.sentence).toBe('A quiet month. Lovely.');
  });

  it('refuses an unknown time zone', () => {
    expect(() => fixture().report('30d', 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});

describe('minimums flip exactly at the threshold', () => {
  it('arrivals: 49 is not enough, 50 is', () => {
    const f = fixture();
    arrivals(
      f,
      Array.from({ length: 49 }, (_, i) => ago(1, -i / 10)),
    );
    expect(f.report().rhythm.arrivals.data).toBeNull();
    f.item('the-fiftieth', { seen: ago(2) });
    const r = f.report();
    expect(r.rhythm.arrivals.n).toBe(50);
    expect(r.rhythm.arrivals.data).not.toBeNull();
  });

  it('outcomes: 19 resolved is not enough, 20 is; agreement: 29 judged, then 30', () => {
    const f = fixture();
    for (let i = 0; i < 29; i++) {
      f.item(`i${i}`, { seen: ago(3) });
      if (i < 19) f.done(`i${i}`, ago(2), { suggested: 'act', suggestedConfidence: 'high' });
      else f.snooze(`i${i}`, ago(2), ago(-5), { suggested: 'act', suggestedConfidence: 'high' });
    }
    // 19 dones + 10 snoozes: 29 outcomes but agreement judged 29
    let r = f.report();
    expect(r.responses.outcomes.n).toBe(29);
    expect(r.predictions.agreement).toMatchObject({ n: 29, data: null });
    f.item('x', { seen: ago(3) });
    f.dismiss('x', ago(2), { suggested: 'act', suggestedConfidence: 'high' });
    r = f.report();
    expect(r.predictions.agreement.data).toEqual({ hits: 29, total: 30, ambiguous: 0, bulk: 0 });

    const g = fixture();
    for (let i = 0; i < 20; i++) g.item(`j${i}`, { seen: ago(3) });
    for (let i = 0; i < 19; i++) g.done(`j${i}`, ago(2));
    expect(g.report().responses.outcomes.data).toBeNull();
    g.done('j19', ago(2));
    expect(g.report().responses.outcomes.data?.counts.done).toBe(20);
  });

  it('a meter row under its own minimum carries no rate, while its neighbours do', () => {
    const f = fixture();
    for (let i = 0; i < 12; i++) {
      f.item(`pr${i}`, { seen: ago(5) });
      if (i < 6) f.replied(`pr${i}`, ago(4));
      else f.done(`pr${i}`, ago(4));
    }
    for (let i = 0; i < 3; i++) {
      f.item(`is${i}`, { seen: ago(5), kind: 'issue' });
      f.replied(`is${i}`, ago(4));
    }
    const rows = f.report().responses.replyBySource.data!.rows;
    expect(rows).toEqual([
      { provider: 'github', kind: 'pr', n: 12, hits: 6, rate: 0.5 },
      { provider: 'github', kind: 'issue', n: 3, hits: 3, rate: null },
    ]);
  });
});

describe('what counts', () => {
  it('an undo cancels the outcome and the action, and is counted in the undo corner', () => {
    const f = fixture();
    f.item('a', { seen: ago(3) });
    const done = f.done('a', ago(2));
    f.ev('a', ago(2, 1), 'undo', { from: 'done', to: 'inbox', meta: { actionId: 1000, originalEventId: done } });
    f.replied('a', ago(1));
    const r = f.report();
    expect(r.rhythm.actions.n).toBe(1); // only the reply
    expect(r.responses.undos.data).toEqual({ undos: 1, actions: 1 });
    // The outcome is the reply, not the undone done.
    const g = fixture();
    for (let i = 0; i < 20; i++) {
      g.item(`i${i}`, { seen: ago(3) });
      const id = g.done(`i${i}`, ago(2));
      g.ev(`i${i}`, ago(2, 1), 'undo', { meta: { originalEventId: id } });
      g.replied(`i${i}`, ago(1));
    }
    expect(g.report().responses.outcomes.data?.counts).toMatchObject({ replied: 20, done: 0 });
  });

  it('a backfilled undo (no originalEventId) cancels by action id', () => {
    const f = fixture();
    f.item('a', { seen: ago(3) });
    f.ev('a', ago(2), 'state', { from: 'inbox', to: 'done', meta: { actionId: 7, reason: 'done', backfilled: true } });
    f.ev('a', ago(2, 1), 'undo', { meta: { actionId: 7, original: 'state', backfilled: true } });
    expect(f.report().rhythm.actions.n).toBe(0);
  });

  it('bulk actions count once in the rhythm, never in rates or accuracy', () => {
    const f = fixture();
    const ids = Array.from({ length: 30 }, (_, i) => f.item(`b${i}`, { seen: ago(5) }));
    f.bulkDone(ids, ago(1));
    for (const id of ids) {
      // Every item had a suggestion: bulk keeps all of them out of the accuracy.
      f.db.prepare("UPDATE item_events SET meta = json_set(meta, '$.suggested', 'act') WHERE item_id = ?").run(id);
    }
    const r = f.report();
    expect(r.rhythm.actions.n).toBe(1);
    expect(r.responses.undos.data).toEqual({ undos: 0, actions: 1 });
    expect(r.responses.outcomes).toMatchObject({ n: 0, data: null });
    expect(r.predictions.agreement.n).toBe(0);
    expect(r.responses.replyBySource.n).toBe(0);
    // The sentence still knows the owner cleared them.
    expect(r.extras.busiestDay.data).toEqual({ day: '2026-11-15', actions: 1 });
  });

  it('a browser decision flagged bulk makes a one-item change bulk too', () => {
    const f = fixture();
    for (let i = 0; i < 20; i++) {
      f.item(`i${i}`, { seen: ago(5) });
      f.done(`i${i}`, ago(1));
    }
    f.ev('i0', ago(1) + 30_000, 'decision', { to: 'done', meta: { bulk: true, selectionSize: 40 } });
    const o = f.report().responses.outcomes;
    expect(o.data).toBeNull(); // 19 single, one bulk
    expect(o.n).toBe(19);
  });

  it('keeps a legacy done ambiguous for the robot, and as its own grey segment', () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) {
      f.item(`i${i}`, { seen: ago(5) });
      f.legacy(`i${i}`, ago(1), { suggested: i % 2 ? 'skip' : 'reply', suggestedConfidence: 'low' });
    }
    const r = f.report();
    expect(r.responses.outcomes.data?.counts).toMatchObject({ legacy: 30, done: 0, dismissed: 0 });
    expect(r.predictions.agreement.n).toBe(15); // the 15 reply suggestions: certainly not replied
    expect(r.predictions.confusion.n).toBe(30);
    const leg = r.predictions.confusion.data?.cells;
    expect(leg?.[0]?.[4]).toBe(15); // reply × legacy
    expect(leg?.[2]?.[4]).toBe(15); // skip × legacy
  });

  it('outcomes: closed upstream before the owner got to it, or cleared by their own reply further down the thread', () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) {
      f.item(`u${i}`, { seen: ago(3) });
      f.ev(`u${i}`, ago(2), 'state', {
        from: 'inbox',
        to: 'resolved',
        source: 'sync',
        meta: { reason: 'closed_upstream' },
      });
      f.done(`u${i}`, ago(1)); // too late: upstream got there first
      f.item(`a${i}`, { provider: 'youtube', kind: 'comment', seen: ago(3), container: 'v', data: null });
      f.ev(`a${i}`, ago(2), 'state', {
        from: 'inbox',
        to: 'auto_replied',
        source: 'auto',
        meta: { reason: 'own_reply' },
      });
    }
    expect(f.report().responses.outcomes.data?.counts).toMatchObject({ upstream: 10, replied: 10, done: 0 });
  });

  it('an import is not an arrival: seen a year after it was written', () => {
    const f = fixture();
    f.item('old', { seen: ago(1), occurred: ago(366) });
    f.item('lagged', { seen: ago(1), occurred: ago(1) - LIVE_LAG_MS - 1 });
    f.item('live', { seen: ago(1), occurred: ago(1) - LIVE_LAG_MS + 60_000 });
    const r = f.report();
    expect(r.rhythm.arrivals.n).toBe(1);
    expect(r.backlog.inboxAge.n).toBe(3); // still waiting, all three
  });

  it('counts an upstream re-arrival (new activity, reopened) as an arrival, but not other sync moves', () => {
    const f = fixture();
    f.item('a', { seen: ago(200), occurred: ago(200) });
    f.ev('a', ago(2), 'state', { from: 'done', to: 'inbox', source: 'sync', meta: { reason: 'new_activity' } });
    f.ev('a', ago(1), 'state', { from: 'done', to: 'inbox', source: 'sync', meta: { reason: 'reopened' } });
    f.ev('a', ago(1), 'state', { from: 'inbox', to: 'own', source: 'sync', meta: { reason: 'mine' } });
    expect(f.report().rhythm.arrivals.n).toBe(2);
  });

  it('leaves out archived and muted items, your own, and their events, everywhere', () => {
    const f = fixture();
    f.item('muted', { seen: ago(1), muted: true, state: 'archived' });
    f.item('archived', { seen: ago(1), state: 'archived' });
    f.item('own', { seen: ago(1), isOwn: true, state: 'own' });
    for (const id of ['muted', 'archived', 'own']) f.done(id, ago(0, -1));
    const r = f.report();
    expect(r.empty).toBe(true);
    // Backlog over time is a replay of the Inbox view itself (n = days of history), so it is the one exception.
    for (const [name, c] of cards(r)) if (name !== 'backlog.overTime') expect(c.n, name).toBe(0);
    expect(r.backlog.overTime.data).toBeNull();
  });

  it('never puts an item body in the report', () => {
    const f = fixture();
    for (let i = 0; i < 60; i++) {
      f.item(`y${i}`, {
        provider: 'youtube',
        kind: 'comment',
        seen: ago(3, i % 24),
        container: 'vid1',
        containerTitle: 'A video',
        author: `Person ${i % 4}`,
        body: 'SECRET BODY TEXT',
        data: null,
      });
      if (i % 2) f.replied(`y${i}`, ago(2, i % 24));
    }
    const text = JSON.stringify(f.report());
    expect(text).not.toContain('SECRET');
    expect(text).toContain('Person 0'); // names are there, as the inbox shows them
  });
});

describe('time zones and calendar days', () => {
  it('the same moments land in a different hour in UTC, London (BST) and Los Angeles', () => {
    const t = Date.parse('2026-07-01T15:30:00.000Z'); // a Wednesday
    const now = Date.parse('2026-07-02T12:00:00.000Z');
    const f = fixture();
    for (let i = 0; i < 50; i++) {
      f.item(`a${i}`, { seen: t - DAY });
      f.done(`a${i}`, t + i * 1000);
    }
    const peak = (tz: string) => f.report('7d', tz, now).rhythm.actions.data!.peak;
    expect(peak('UTC')).toMatchObject({ weekday: 3, hour: 15, count: 50 });
    expect(peak('Europe/London')).toMatchObject({ weekday: 3, hour: 16, count: 50 });
    expect(peak('America/Los_Angeles')).toMatchObject({ weekday: 3, hour: 8, count: 50 });
  });

  it('spring forward: there is no 01:00 in London on 29 March; the hours either side count', () => {
    const lc = localClock('Europe/London');
    expect(lc.hour(Date.parse('2026-03-29T00:30:00.000Z'))).toBe(0);
    expect(lc.hour(Date.parse('2026-03-29T01:30:00.000Z'))).toBe(2);
    const f = fixture();
    const now = Date.parse('2026-03-30T12:00:00.000Z');
    const times = Array.from({ length: 50 }, (_, i) => Date.parse('2026-03-29T00:00:00.000Z') + i * 6 * 60_000); // 00:00-04:54Z
    arrivals(f, times);
    const g = f.report('7d', 'Europe/London', now).rhythm.hourly.data;
    expect(g).toBeNull(); // no actions: R3 needs both
    const a = f.report('7d', 'Europe/London', now).rhythm.arrivals.data!;
    const sunday = a.counts[0]!;
    expect(sunday[0]).toBe(10); // 00:00-00:54 GMT
    expect(sunday[1]).toBe(0); // the hour that never happened
    expect(sunday[2]).toBe(10); // 01:00Z is 02:00 BST
    expect(sunday.reduce((x, y) => x + y, 0)).toBe(50);
  });

  it('fall back: 01:00 happens twice in London on 25 October, and both count in that hour', () => {
    const f = fixture();
    const now = Date.parse('2026-10-26T12:00:00.000Z');
    // 00:00-01:59Z on the 25th is 01:00-01:59 BST then 01:00-01:59 GMT.
    const times = Array.from({ length: 50 }, (_, i) => Date.parse('2026-10-25T00:00:00.000Z') + i * 144_000);
    arrivals(f, times);
    const a = f.report('7d', 'Europe/London', now).rhythm.arrivals.data!;
    expect(a.counts[0]![1]).toBe(50);
    // The range covers seven calendar days whatever their length: one of each weekday.
    expect(a.weekdays).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(a.perDay[0]![1]).toBe(50);
    expect(a.peak).toEqual({ weekday: 0, hour: 1, perDay: 50, count: 50 });
  });

  it('normalises by calendar days: thirty days hold 30 weekdays, across a DST change too', () => {
    const f = fixture();
    f.item('a', { seen: ago(1) });
    const r = f.report('30d', 'Europe/London');
    expect(r.days).toBe(30);
    expect(r.from).toBe('2026-10-18');
    const g = fixture();
    arrivals(
      g,
      // 50 arrivals on Mondays at 09:30 UTC, spread over the five Mondays the range covers (Oct 19 ... Nov 16).
      Array.from({ length: 50 }, (_, i) => Date.parse('2026-10-19T09:30:00.000Z') + (i % 5) * 7 * DAY + i * 1000),
    );
    const a = g.report('30d', 'Europe/London').rhythm.arrivals.data!;
    expect(a.weekdays.reduce((x, y) => x + y, 0)).toBe(30);
    expect(a.weekdays[1]).toBe(5); // Mondays Oct 19, 26, Nov 2, 9, 16
    // 10:30 BST on Oct 19, 09:30 GMT afterwards.
    expect(a.counts[1]![10]).toBe(10);
    expect(a.counts[1]![9]).toBe(40);
    expect(a.perDay[1]![9]).toBe(8);
  });

  it('"all" starts at the first thing the history knows of', () => {
    const f = fixture();
    f.item('a', { seen: ago(100) });
    f.done('a', ago(99));
    const r = f.report('all');
    expect(r.from).toBe('2026-08-08');
    expect(r.days).toBe(101);
  });
});

describe('the cards', () => {
  it('first response time per provider, with a median and p75 once a provider has ten', () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) {
      f.item(`g${i}`, { seen: ago(5) });
      f.done(`g${i}`, ago(5) + (i + 1) * HOUR);
    }
    for (let i = 0; i < 4; i++) {
      f.item(`y${i}`, { provider: 'youtube', kind: 'comment', seen: ago(5), data: null, container: 'v' });
      f.done(`y${i}`, ago(4));
    }
    const d = f.report().rhythm.firstResponse.data!;
    expect(d.byProvider).toEqual([
      { provider: 'github', n: 10, medianMs: 5.5 * HOUR, p75Ms: 7.75 * HOUR },
      { provider: 'youtube', n: 4, medianMs: null, p75Ms: null },
    ]);
  });

  it('reply rate by thread size uses the size when the owner acted, and says how many were from today’s size', () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) {
      f.item(`s${i}`, { seen: ago(5), data: { comments: 50 } }); // big now, small when the owner acted
      f.replied(`s${i}`, ago(4), { threadSize: 2 });
    }
    for (let i = 0; i < 10; i++) {
      f.item(`b${i}`, { seen: ago(5), data: { comments: 20 } });
      f.done(`b${i}`, ago(4)); // no threadSize: from before it was recorded
    }
    const d = f.report().responses.replyBySize.data!;
    expect(d.rows).toEqual([
      { band: '0', n: 0, hits: 0, rate: null },
      { band: '1-3', n: 10, hits: 10, rate: 1 },
      { band: '4-10', n: 0, hits: 0, rate: null },
      { band: '11+', n: 10, hits: 0, rate: 0 },
    ]);
    expect(d.approx).toBe(10);
  });

  it('snooze habits: how each snooze ended, by reason', () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) {
      f.item(`s${i}`, { seen: ago(10) });
      f.snooze(`s${i}`, ago(9), ago(5), { bucket: 'waiting_on_them', untilActivity: true });
      if (i < 6)
        f.ev(`s${i}`, ago(8), 'snooze', {
          from: iso(ago(5)),
          source: 'auto',
          meta: { reason: 'wake', cause: 'activity' },
        });
      else if (i < 8)
        f.ev(`s${i}`, ago(5), 'snooze', {
          from: iso(ago(5)),
          source: 'auto',
          meta: { reason: 'wake', cause: 'fallback' },
        });
      else if (i < 9) f.ev(`s${i}`, ago(7), 'snooze', { from: iso(ago(5)), meta: { cause: 'manual' } });
    }
    const d = f.report().responses.snoozes.data!;
    expect(d.rows).toEqual([
      {
        bucket: 'waiting_on_them',
        n: 10,
        activity: 6,
        fallback: 2,
        manual: 1,
        timed: 0,
        open: 1,
        medianMs: 1 * DAY,
      },
    ]);
  });

  it('predictions: by suggestion, calibration, whose turn and categories (recorded, or approximated from today)', () => {
    const f = fixture();
    let n = 0;
    const act = (suggested: string, what: 'replied' | 'done' | 'dismiss', extra: Record<string, unknown>) => {
      const id = f.item(`p${n++}`, { seen: ago(5) });
      f[what](id, ago(4), { suggested, ...extra });
      return id;
    };
    for (let i = 0; i < 10; i++)
      act('reply', i < 8 ? 'replied' : 'done', {
        suggestedConfidence: 'high',
        suggestedTurn: 'me',
        suggestedCategory: 'question',
      });
    for (let i = 0; i < 10; i++)
      act('skip', i < 3 ? 'dismiss' : 'replied', {
        suggestedConfidence: 'medium',
        suggestedTurn: 'them',
        suggestedCategory: 'thanks',
      });
    for (let i = 0; i < 10; i++) {
      const id = act('skip', 'replied', { suggestedConfidence: 'medium' });
      f.db
        .prepare(
          `INSERT INTO suggestions (item_id, state_key, verdict, category, confidence, reason, model, prompt_version, created_at)
           VALUES (?, 'k', 'no_reply_needed', 'praise', 'medium', 'r', 'm', 'p', ?)`,
        )
        .run(id, iso(ago(4)));
    }
    const p = f.report().predictions;
    expect(p.agreement.data).toEqual({ hits: 11, total: 30, ambiguous: 0, bulk: 0 });
    expect(p.bySuggestion.data!.rows.find((r) => r.suggested === 'skip')).toEqual({
      suggested: 'skip',
      n: 20,
      hits: 3,
      rate: 0.15,
    });
    expect(p.calibration.data!.rows.map((r) => [r.confidence, r.rate])).toEqual([
      ['low', null],
      ['medium', 0.15],
      ['high', 0.8],
    ]);
    expect(p.calibration.data!.highNotBetter).toBe(false);
    expect(p.turns.data!.rows).toEqual([
      { turn: 'me', n: 10, hits: 8, rate: 0.8 },
      { turn: 'them', n: 10, hits: 7, rate: 0.7 },
      { turn: 'nobody', n: 0, hits: 0, rate: null },
    ]);
    expect(p.categories.data!.rows).toEqual([
      { category: 'praise', n: 10, overrides: 10, approx: 10, rate: 1 },
      { category: 'thanks', n: 10, overrides: 7, approx: 0, rate: 0.7 },
      { category: 'question', n: 10, overrides: 2, approx: 0, rate: 0.2 },
    ]);
    expect(p.categories.data!.capturedSince).toBe(iso(ago(4)));
  });

  it('sources: noisiest repos with the rest folded, regulars without bots, your accounts or the few', () => {
    const f = fixture();
    f.db
      .prepare("INSERT INTO settings (key, value) VALUES ('github', ?)")
      .run(JSON.stringify({ token: 'SECRET-TOKEN', myAccounts: ['Sam-Sample'] }));
    let n = 0;
    const add = (repo: string, author: string, count: number, data: Record<string, unknown> = { comments: 0 }) => {
      for (let i = 0; i < count; i++) f.item(`r${n++}`, { seen: ago(3), container: repo, author, data });
    };
    for (let r = 0; r < 10; r++) add(`org/repo${r}`, 'dave', 10 - r);
    add('org/bots', 'dependabot[bot]', 9);
    add('org/bots', 'renovate', 4, { authorType: 'Bot', comments: 0 });
    add('org/bots', 'sam-sample', 6);
    add('org/x', 'erin', 3);
    add('org/x', 'frank', 2);
    const s = f.report().sources;
    expect(s.repos.data!.rows[0]).toEqual({ label: 'org/bots', n: 19 });
    expect(s.repos.data!.rows).toHaveLength(8);
    expect(s.repos.n).toBe(55 + 19 + 5);
    expect(s.repos.data!.other).toBe(s.repos.n - s.repos.data!.rows.reduce((a, r) => a + r.n, 0));
    expect(s.regulars.data!.rows).toEqual([
      { label: 'dave', n: 55 },
      { label: 'erin', n: 3 },
    ]);
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });

  it('the longest threads link to an item; a YouTube thread is one entry, not one per comment', () => {
    const f = fixture();
    f.db.prepare("INSERT INTO videos (id, title, channel_title) VALUES ('v1', 'Advent #12', 'Chan')").run();
    f.db
      .prepare(
        "INSERT INTO threads (id, video_id, top_comment_id, total_reply_count, last_activity_at) VALUES ('t1', 'v1', 't1', 14, ?)",
      )
      .run(iso(ago(1)));
    for (const id of ['t1', 't1.r1', 't1.r2']) {
      f.db
        .prepare(
          `INSERT INTO comments (id, thread_id, video_id, author_name, text_html, text_plain, published_at, updated_at,
             first_seen_at) VALUES (?, 't1', 'v1', 'A', 'x', 'x', ?, ?, ?)`,
        )
        .run(id, iso(ago(1)), iso(ago(1)), iso(ago(1)));
      f.item(id, { provider: 'youtube', kind: 'comment', seen: ago(1), container: 'v1', author: 'Ann', data: null });
    }
    f.item('gh', { seen: ago(1), data: { comments: 30 }, title: 'Huge' });
    f.item('small', { seen: ago(1), data: { comments: 9 } });
    const t = f.report().sources.threads.data!.rows;
    expect(t).toEqual([
      { itemId: 'gh', label: 'org/app: Huge', provider: 'github', size: 30 },
      { itemId: 't1', label: 'Ann on “Advent #12”', provider: 'youtube', size: 14 },
    ]);
  });

  it('backlog: age bands from when it last came back, the elder, and what is snoozed now', () => {
    const f = fixture();
    f.item('new', { seen: ago(0, -2) });
    f.item('week', { seen: ago(3) });
    f.item('woke', { seen: ago(200), wokeAt: ago(10) });
    f.item('ancient', { seen: ago(120), title: 'Old thing' });
    f.item('parked', { seen: ago(50), snoozedUntil: ago(-3), snoozedAt: ago(4), bucket: 'in_flight' });
    f.item('parked2', { seen: ago(50), snoozedUntil: ago(-3), snoozedAt: ago(2), bucket: 'in_flight' });
    f.item('gone', { seen: ago(300), state: 'done' });
    const b = f.report('7d').backlog;
    expect(b.inboxAge.data!.bands).toEqual([
      { band: '<1d', n: 1 },
      { band: '1-7d', n: 1 },
      { band: '1-4w', n: 1 },
      { band: '1-3m', n: 0 },
      { band: '3m+', n: 1 },
    ]);
    expect(b.elder.data).toMatchObject({ itemId: 'ancient', label: 'org/app: Old thing', ageMs: 120 * DAY });
    expect(b.snoozedNow.data!.rows).toEqual([{ bucket: 'in_flight', n: 2, medianDays: 3 }]);
  });

  it('extras: busiest day, quietest hour, biggest thread cleared, polyglot days', () => {
    const f = fixture();
    // Arrivals at 12:00-23:00 and 00:00-07:00 UTC on five days; nothing ever arrives 08:00-11:59.
    for (let i = 0; i < 50; i++) f.item(`a${i}`, { seen: ago(1 + (i % 5), i % 20) });
    f.item('big', { seen: ago(2), data: { comments: 40 }, title: 'Big one' });
    f.replied('big', ago(1));
    f.item('yt', { provider: 'youtube', kind: 'comment', seen: ago(2), container: 'v', data: null });
    f.replied('yt', ago(1, 2));
    f.done('a1', ago(3));
    f.done('a2', ago(3, 1));
    const e = f.report('7d').extras;
    expect(e.busiestDay.data).toEqual({ day: '2026-11-15', actions: 2 }); // the later of the tied days
    expect(e.quietestHour.data).toEqual({ hour: 8, perDay: 0 });
    expect(e.biggestCleared.data).toMatchObject({ itemId: 'big', size: 40 });
    expect(e.polyglot.data).toEqual({ days: 1, last: '2026-11-15' });
  });

  it('the sentence names what the owner did, when, the loudest source and the robot, once the numbers are there', () => {
    const f = fixture();
    for (let i = 0; i < 60; i++) {
      f.item(`i${i}`, { seen: ago(2), container: i < 40 ? 'org/loud' : 'org/quiet' });
      const at = ago(1, -12 + (i % 3)); // 00:00-02:00 UTC
      if (i < 20) f.replied(`i${i}`, at, { suggested: 'reply', suggestedConfidence: 'high' });
      else if (i < 55) f.done(`i${i}`, at, { suggested: i < 32 ? 'reply' : 'act' });
    }
    const r = f.report();
    expect(r.predictions.agreement.data).toMatchObject({ hits: 43, total: 55 });
    expect(r.sentence).toBe(
      'You answered 20 things and cleared 35 more, mostly PRs, mostly after midnight; org/loud was the loudest and the robot agreed 4 times in 5.',
    );
  });
});

describe('backlog over time (the inbox replay)', () => {
  it('needs 14 days of history, then gives the count at the end of each local day', () => {
    const f = fixture();
    f.item('a', { seen: ago(10) });
    f.item('b', { seen: ago(10) });
    f.done('a', ago(5));
    expect(f.report().backlog.overTime).toMatchObject({ n: 11, data: null });
    f.item('c', { seen: ago(20) });
    const d = f.report().backlog.overTime.data!.days;
    expect(d).toHaveLength(21);
    expect(d[0]).toEqual({ day: '2026-10-27', count: 1 });
    expect(d.find((x) => x.day === '2026-11-06')?.count).toBe(3);
    expect(d.at(-1)).toEqual({ day: '2026-11-16', count: 2 });
  });

  it('agrees with the real repository after triage, bulk, undo, snoozes and the waker', () => {
    let now = NOW - 3 * DAY;
    const db = openDb(':memory:');
    const repo = createRepo(db, () => new Date(now));
    const ids = Array.from({ length: 6 }, (_, i) => repo.addTodo({ title: `t${i}`, notes: '', raw: '', dueAt: null }));
    now += HOUR;
    const r1 = repo.triage([ids[0]!], 'done');
    repo.triage([ids[1]!, ids[2]!], 'done');
    repo.undo(r1.actionId);
    repo.snooze([ids[3]!], new Date(now + 2 * HOUR).toISOString());
    repo.triage([ids[4]!], 'done', 'no_action');
    now += DAY;
    repo.wakeSnoozed();
    const counts = inboxCountByDay(db, { now, tz: 'UTC', from: 0, to: localClock('UTC').day(now) });
    expect(counts.at(-1)!.count).toBe(repo.counts().inbox);
    expect(repo.counts().inbox).toBe(3);
  });
});

describe('read only', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('works on a database opened read-only, and the cached reader answers the same until the history moves', () => {
    dir = mkdtempSync(join(tmpdir(), 'nudge-insights-'));
    const path = join(dir, 'x.db');
    const f = fixture(openDb(path));
    for (let i = 0; i < 60; i++) {
      f.item(`i${i}`, { seen: ago(3, i % 24) });
      if (i % 2) f.done(`i${i}`, ago(2, i % 24));
    }
    const before = f.report();
    f.db.close();
    const ro = new Database(path, { readonly: true }) as unknown as Db;
    try {
      let t = NOW;
      const reader = createInsightsReader(ro, () => new Date(t));
      const a = reader.report('30d', 'UTC');
      expect(a).toEqual(before);
      expect(reader.report('30d', 'UTC')).toBe(a); // cached
      expect(reader.report('7d', 'UTC')).not.toBe(a);
      expect(reader.report('30d', 'Europe/London')).not.toBe(a);
      t += 6 * 60_000; // entries expire after five minutes
      expect(reader.report('30d', 'UTC')).not.toBe(a);
    } finally {
      ro.close();
    }
  });

  it('the cache notices a new event', () => {
    const f = fixture();
    f.item('a', { seen: ago(2) });
    const reader = createInsightsReader(f.db, () => new Date(NOW));
    const a = reader.report('30d', 'UTC');
    f.done('a', ago(1));
    const b = reader.report('30d', 'UTC');
    expect(b).not.toBe(a);
    expect(b.rhythm.actions.n).toBe(1);
  });
});

it('documents its minimums in one place', () => {
  expect(MIN.arrivals).toBe(50);
  expect(MIN.outcomes).toBe(20);
  expect(MIN.agreement).toBe(30);
});
