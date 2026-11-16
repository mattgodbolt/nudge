import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { createSpend } from './spend.js';
import { createUsage } from './usage.js';

function setup(start = '2026-11-14T10:00:00.000Z') {
  const db = openDb(':memory:');
  let now = new Date(start);
  const clock = () => now;
  return {
    db,
    spend: createSpend(db, clock),
    usage: createUsage(db, clock),
    setNow: (s: string) => (now = new Date(s)),
  };
}

describe('spend ledger', () => {
  it('adds every purpose into one figure for today (UTC), and starts again tomorrow', () => {
    const { spend, setNow } = setup();
    expect(spend.todayUsd()).toBe(0);
    spend.add('suggest', 1_000_000);
    spend.add('snooze_ai', 250_000);
    spend.add('assistant', 500_000);
    spend.add('suggest', 250_000);
    expect(spend.todayUsd()).toBeCloseTo(2);
    setNow('2026-11-15T00:00:01.000Z');
    expect(spend.todayUsd()).toBe(0);
  });

  it('ignores nothing-costs and nonsense', () => {
    const { db, spend } = setup();
    spend.add('suggest', 0);
    spend.add('suggest', -5);
    spend.add('suggest', Number.NaN);
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 0 });
  });

  it('rounds fractional micro-dollars instead of dropping them', () => {
    const { spend } = setup();
    spend.add('suggest', 0.6);
    expect(spend.todayUsd()).toBeCloseTo(0.000001);
  });

  it('is not erased by "Reset usage data"', () => {
    const { spend, usage } = setup();
    spend.add('snooze_ai', 3_000_000);
    usage.add({ 'snooze_ai.cost_micros': 3_000_000 });
    usage.reset();
    expect(spend.todayUsd()).toBeCloseTo(3);
  });
});

describe('migration 017 (llm_spend)', () => {
  it('carries the spend already recorded into the ledger, keeping every existing row', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS.slice(0, 16).join('\n'));
    db.pragma('user_version = 16');
    db.prepare(
      "INSERT INTO items (id, provider, kind, state, state_source, state_changed_at, first_seen_at, occurred_at) VALUES (?, 'github', 'pr', 'inbox', 'sync', 'x', 'x', 'x')",
    ).run('a');
    db.prepare(
      "INSERT INTO items (id, provider, kind, state, state_source, state_changed_at, first_seen_at, occurred_at) VALUES (?, 'github', 'pr', 'inbox', 'sync', 'x', 'x', 'x')",
    ).run('b');
    const sug = db.prepare(
      `INSERT INTO suggestions (item_id, state_key, verdict, category, confidence, reason, model, prompt_version, cost_usd, created_at)
       VALUES (?, 'k', 'spam', 'bot', 'high', 'r', 'claude-haiku-5-5', 'p', ?, ?)`,
    );
    sug.run('a', 0.25, '2026-11-13T23:00:00.000Z');
    sug.run('b', 0.5, '2026-11-14T08:00:00.000Z');
    const use = db.prepare('INSERT INTO usage_daily (day, key, count) VALUES (?, ?, ?)');
    use.run('2026-11-14', 'snooze_ai.cost_micros', 120_000);
    use.run('2026-11-14', 'assistant.cost_micros', 30_000);
    use.run('2026-11-14', 'done.kbd', 7);

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT day, purpose, micros FROM llm_spend ORDER BY day, purpose').all()).toEqual([
      { day: '2026-11-13', purpose: 'suggest', micros: 250_000 },
      { day: '2026-11-14', purpose: 'assistant', micros: 30_000 },
      { day: '2026-11-14', purpose: 'snooze_ai', micros: 120_000 },
      { day: '2026-11-14', purpose: 'suggest', micros: 500_000 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM suggestions').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get()).toEqual({ n: 3 });
    expect(() => db.prepare("INSERT INTO llm_spend (day, purpose, micros) VALUES ('d', 'other', 1)").run()).toThrow();
  });

  it('works on a database that never spent anything', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS.slice(0, 16).join('\n'));
    db.pragma('user_version = 16');
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 0 });
  });
});
