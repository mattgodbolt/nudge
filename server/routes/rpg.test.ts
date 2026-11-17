import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { Repo } from '../contracts.js';
import { openDb } from '../db/db.js';
import { createRepo } from '../db/repo.js';
import { createRpgReader } from '../db/rpg.js';
import { makeBus } from '../sync/test-helpers.js';
import { createQuotaTracker } from '../sync/quota.js';
import type { RpgClaim, RpgSheet } from '../../shared/types.js';
import { sender, testDeps } from './test-helpers.js';

// Real repository and routes: Adventure mode's endpoints, its settings, and the rule that it changes nothing else.
let app: FastifyInstance;
let repo: Repo;
let now: number;
let todos: string[];

const send = sender(() => app);
const claim = async (tz = 'UTC') => (await send('POST', '/api/rpg/claim', { tz })).json() as RpgClaim;

beforeEach(() => {
  now = Date.parse('2026-11-10T12:00:00.000Z');
  const clock = () => new Date(now);
  const db = openDb(':memory:');
  repo = createRepo(db, clock);
  todos = Array.from({ length: 60 }, (_, i) => repo.addTodo({ title: `todo ${i}`, notes: '', raw: '', dueAt: null }));
  now += 60_000;
  const bus = makeBus();
  app = buildApp(
    testDeps(repo, {
      bus,
      quota: createQuotaTracker({ repo, getSettings: () => repo.getSettings(), clock }),
      rpg: createRpgReader(db, clock),
    }),
  );
});
afterEach(() => app.close());

describe('GET /api/rpg', () => {
  it('is on by default and answers the sheet for the given zone', async () => {
    expect((await send('GET', '/api/settings')).json().rpg).toEqual({ enabled: true, sound: true, title: null });
    const res = await send('GET', '/api/rpg?tz=Europe/London');
    expect(res.statusCode).toBe(200);
    expect(res.json() as RpgSheet).toMatchObject({ level: 1, xp: 0, day: '2026-11-10' });
  });

  it('refuses an unknown zone and answers 409 when the mode is off', async () => {
    expect((await send('GET', '/api/rpg?tz=Nowhere/Special')).statusCode).toBe(400);
    await send('PUT', '/api/settings', { rpg: { enabled: false } });
    const off = await send('GET', '/api/rpg?tz=UTC');
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('rpg_off');
    expect((await send('POST', '/api/rpg/claim', { tz: 'UTC' })).statusCode).toBe(409);
  });

  it('validates the settings', async () => {
    expect((await send('PUT', '/api/settings', { rpg: { enabled: 'yes' } })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings', { rpg: { title: 0 } })).statusCode).toBe(400);
    const ok = await send('PUT', '/api/settings', { rpg: { sound: false, title: 1 } });
    expect(ok.json().rpg).toEqual({ enabled: true, sound: false, title: 1 });
  });
});

describe('POST /api/rpg/claim', () => {
  it('hands out the arrival once, then each level-up once, whichever device asks', async () => {
    expect((await claim()).news.arrive).toEqual({ level: 1, title: 'Inbox Peasant' });
    expect((await claim()).news.arrive).toBeNull();
    for (const id of todos.slice(0, 59)) {
      repo.triage([id], 'done'); // a todo pays 5: 295 XP is not a level yet
      now += 1000;
    }
    expect((await claim()).news.levelUp).toBeNull();
    repo.triage([todos[59]!], 'done');
    now += 1000;
    const c = await claim('America/New_York');
    expect(c.sheet).toMatchObject({ xp: 300, level: 2 });
    expect(c.news.levelUp).toEqual({ from: 1, to: 2, title: 'Apprentice of the Unread' });
    expect((await claim()).news.levelUp).toBeNull();
  });

  it('starts afresh with "You arrive as" when switched back on, without replaying what happened meanwhile', async () => {
    await claim();
    await send('PUT', '/api/settings', { rpg: { enabled: false } });
    for (const id of todos) repo.triage([id], 'done');
    now += 1000;
    await send('PUT', '/api/settings', { rpg: { enabled: true } });
    const c = await claim();
    expect(c.news.arrive).not.toBeNull();
    expect(c.news.achievements).toEqual([]);
    expect((await claim()).news.achievements).toEqual([]);
  });

  it('migrates what was announced under the old rules: one quiet rebalance line, no level toast, nothing replayed', async () => {
    for (const id of todos.slice(0, 50)) repo.triage([id], 'done'); // 250 XP: level 1 now, level 2 under the old curve
    now += 1000;
    // As stored before the rebalance: no version, a higher level, and Rubber Duck (then 50 todos) announced.
    const r = repo.getSettings().rpg;
    repo.updateSettings({
      rpg: { ...r, seen: { level: 2, achievements: ['first_blood', 'rubber_duck'], bosses: [], loot: [] } },
    });
    const c = await claim();
    expect(c.sheet.level).toBe(1);
    expect(c.news).toMatchObject({
      arrive: null,
      rebalanced: { level: 1, title: 'Inbox Peasant' },
      levelUp: null,
      achievements: [],
    });
    // Rubber Duck II (50 todos) is the old Rubber Duck: earned, and marked seen without a word.
    expect(c.sheet.achievements.find((a) => a.id === 'rubber_duck')).toMatchObject({ tier: 2, earned: true });
    expect(repo.getSettings().rpg.seen).toMatchObject({ v: 2, level: 1 });
    expect(repo.getSettings().rpg.seen!.achievements).toEqual(expect.arrayContaining(['rubber_duck', 'rubber_duck:2']));
    // Said once only, and the next level-up is announced as usual.
    expect((await claim()).news).toMatchObject({ rebalanced: null, levelUp: null, achievements: [] });
    for (const id of todos.slice(50, 60)) repo.triage([id], 'done');
    now += 1000;
    expect((await claim()).news).toMatchObject({ rebalanced: null, levelUp: { from: 1, to: 2 } });
  });

  it('remembers the zone, and the one before it when it changes', async () => {
    await claim('Europe/London');
    expect(repo.getSettings().rpg).toMatchObject({ tz: 'Europe/London', prevTz: null });
    await claim('America/Los_Angeles');
    expect(repo.getSettings().rpg).toMatchObject({ tz: 'America/Los_Angeles', prevTz: 'Europe/London' });
    await claim('America/Los_Angeles');
    expect(repo.getSettings().rpg).toMatchObject({ tz: 'America/Los_Angeles', prevTz: 'Europe/London' });
  });
});

describe('no functional difference', () => {
  it('gives identical inbox, counts and bootstrap output with the mode on and off', async () => {
    repo.triage([todos[0]!], 'done');
    repo.snooze([todos[1]!], new Date(now + 86_400_000).toISOString());
    const snapshot = async () => {
      const out: unknown[] = [];
      for (const view of ['inbox', 'done', 'all', 'snoozed'])
        out.push((await send('GET', `/api/inbox?view=${view}`)).json());
      const boot = (await send('GET', '/api/bootstrap')).json();
      delete boot.settings.rpg; // the switch itself is the only difference
      out.push(boot.counts, boot);
      return JSON.stringify(out);
    };
    await claim();
    await send('GET', '/api/rpg?tz=UTC');
    const on = await snapshot();
    await send('PUT', '/api/settings', { rpg: { enabled: false } });
    const off = await snapshot();
    expect(off).toBe(on);
    // And asking for the sheet changes nothing either.
    await send('PUT', '/api/settings', { rpg: { enabled: true } });
    await claim();
    await send('GET', '/api/rpg?tz=Asia/Kolkata');
    expect(await snapshot()).toBe(on);
  });
});
