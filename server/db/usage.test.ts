import { describe, expect, it } from 'vitest';
import { USAGE_FEATURES, USAGE_KEYS } from '../../shared/usage.js';
import { openDb } from './db.js';
import { createEvents } from './events.js';
import { createUsage } from './usage.js';

function setup(start = '2026-11-10T23:30:00.000Z') {
  const db = openDb(':memory:');
  let now = new Date(start);
  const usage = createUsage(db, () => now);
  return { db, usage, setNow: (s: string) => (now = new Date(s)) };
}

describe('usage store', () => {
  it('accumulates increments into one row per UTC day and key', () => {
    const { db, usage, setNow } = setup();
    usage.add({ 'done.kbd': 2, 'view.stats': 1 });
    usage.add({ 'done.kbd': 3 });
    setNow('2026-11-11T00:10:00.000Z');
    usage.add({ 'done.kbd': 1 });
    expect(db.prepare('SELECT day, key, count FROM usage_daily ORDER BY day, key').all()).toEqual([
      { day: '2026-11-10', key: 'done.kbd', count: 5 },
      { day: '2026-11-10', key: 'view.stats', count: 1 },
      { day: '2026-11-11', key: 'done.kbd', count: 1 },
    ]);
  });

  it('never stores a key outside the allow-list, nor a bad count', () => {
    const { db, usage } = setup();
    const r = usage.add({ 'done.kbd': 1, 'search.run:secret': 4, 'done.btn': -1, 'done.touch': 1.5 });
    expect(r).toEqual({ stored: 1, skipped: ['search.run:secret', 'done.btn', 'done.touch'] });
    expect(db.prepare('SELECT key FROM usage_daily').all()).toEqual([{ key: 'done.kbd' }]);
  });

  it('stores only allow-listed keys even when every key is offered', () => {
    const { db, usage } = setup();
    usage.add(Object.fromEntries(USAGE_KEYS.map((k) => [k, 1])));
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number }).n).toBe(USAGE_KEYS.length);
  });

  it('reports the window, and lists features with no uses in it', () => {
    const { usage, setNow } = setup('2026-11-01T12:00:00.000Z');
    usage.add({ 'done.kbd': 2, 'assistant.cost_micros': 1500 });
    setNow('2026-11-11T12:00:00.000Z');
    usage.add({ 'done.btn': 1, 'view.stats': 1 });

    const week = usage.report(7);
    expect([week.from, week.to]).toEqual(['2026-11-05', '2026-11-11']);
    expect(week.rows).toEqual([
      { day: '2026-11-11', key: 'done.btn', count: 1 },
      { day: '2026-11-11', key: 'view.stats', count: 1 },
    ]);
    expect(week.unused).toContain('snooze');
    expect(week.unused).toContain('assistant.cost_micros');
    expect(week.unused).not.toContain('done');
    expect(week.unused).not.toContain('view.stats');

    const month = usage.report(30);
    expect(month.rows.map((r) => r.key)).toContain('assistant.cost_micros');
    expect(month.unused).not.toContain('assistant.cost_micros');
  });

  it('lists every feature as unused on an empty database', () => {
    expect(setup().usage.report(7).unused).toEqual([...USAGE_FEATURES]);
  });

  it('counts item events by day, kind and source at read time without copying them', () => {
    const { db, usage } = setup('2026-11-11T12:00:00.000Z');
    const ev = createEvents(db);
    const e = (at: string, kind: 'state' | 'snooze', source: 'user' | 'auto') =>
      ev.record({ itemId: 'secret-item-id', at, kind, source, to: 'done' });
    e('2026-11-11T08:00:00.000Z', 'state', 'user');
    e('2026-11-11T09:00:00.000Z', 'state', 'user');
    e('2026-11-11T09:30:00.000Z', 'snooze', 'user');
    e('2026-11-10T09:00:00.000Z', 'state', 'auto');
    e('2026-10-01T09:00:00.000Z', 'state', 'user'); // outside the window

    const r = usage.report(7);
    expect(r.events).toEqual([
      { day: '2026-11-10', kind: 'state', source: 'auto', count: 1 },
      { day: '2026-11-11', kind: 'snooze', source: 'user', count: 1 },
      { day: '2026-11-11', kind: 'state', source: 'user', count: 2 },
    ]);
    expect(JSON.stringify(r)).not.toContain('secret-item-id');
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get()).toEqual({ n: 0 });
  });

  it('resets the counters and leaves the event log alone', () => {
    const { db, usage } = setup();
    createEvents(db).record({ itemId: 'i', at: '2026-11-10T00:00:00.000Z', kind: 'state', source: 'user' });
    usage.add({ 'done.kbd': 1, 'view.stats': 2 });
    expect(usage.reset()).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM item_events').get()).toEqual({ n: 1 });
  });
});
