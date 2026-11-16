import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/db.js';
import { insightsReport } from '../db/insights.js';
import { seedDemoHistory } from './history.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function withItems(n: number): Db {
  const db = openDb(':memory:');
  const at = new Date(NOW - 60_000).toISOString();
  const ins = db.prepare(
    `INSERT INTO items (id, provider, kind, container_key, container_title, author, occurred_at, state, state_source,
       state_changed_at, first_seen_at) VALUES (?, 'youtube', 'comment', 'v1', 'Video', ?, ?, 'inbox', 'sync', ?, ?)`,
  );
  for (let i = 0; i < n; i++) ins.run(`c${String(i).padStart(3, '0')}`, `Person ${i % 7}`, at, at, at);
  return db;
}
const userEvents = (db: Db) =>
  (db.prepare("SELECT COUNT(*) AS n FROM item_events WHERE source = 'user'").get() as { n: number }).n;

describe('demo history (NUDGE_DEMO_HISTORY)', () => {
  it('waits for enough items, changing nothing until then', () => {
    const db = withItems(59);
    expect(seedDemoHistory(db, NOW)).toBe(false);
    expect(userEvents(db)).toBe(0);
  });

  it("is not put off by today's decoration snoozes, only by history from before today", () => {
    const db = withItems(80);
    db.prepare(
      "INSERT INTO item_events (item_id, at, kind, to_value, source, meta) VALUES ('c000', ?, 'snooze', ?, 'user', '{}')",
    ).run(new Date(NOW - 60_000).toISOString(), new Date(NOW + 300 * 86_400_000).toISOString());
    expect(seedDemoHistory(db, NOW)).toBe(true);
    expect(userEvents(db)).toBeGreaterThan(20);
  });

  it('gives the Insights section weeks of history, deterministically, and only once', () => {
    const a = withItems(150);
    const b = withItems(150);
    expect(seedDemoHistory(a, NOW)).toBe(true);
    expect(seedDemoHistory(b, NOW)).toBe(true);
    const r = insightsReport(a, { range: '30d', tz: 'UTC', now: new Date(NOW) });
    expect(r.rhythm.arrivals.data).not.toBeNull();
    expect(r.rhythm.actions.data).not.toBeNull();
    expect(r.responses.outcomes.data).not.toBeNull();
    expect(r.predictions.agreement.data).not.toBeNull();
    expect(r.responses.undos.data?.undos).toBe(1);
    expect(r.backlog.overTime.data).not.toBeNull();
    expect(insightsReport(b, { range: '30d', tz: 'UTC', now: new Date(NOW) })).toEqual(r);
    const n = userEvents(a);
    expect(seedDemoHistory(a, NOW)).toBe(true);
    expect(userEvents(a)).toBe(n);
    // Every event is in the past.
    const latest = (a.prepare('SELECT MAX(at) AS t FROM item_events').get() as { t: string }).t;
    expect(Date.parse(latest)).toBeLessThanOrEqual(NOW);
  });
});
