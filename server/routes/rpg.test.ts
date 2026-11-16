import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { Repo, SyncEngine } from '../contracts.js';
import { openDb } from '../db/db.js';
import { createRepo } from '../db/repo.js';
import { createRpgReader } from '../db/rpg.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeBus } from '../sync/test-helpers.js';
import { createQuotaTracker } from '../sync/quota.js';
import type { RpgClaim, RpgSheet } from '../../shared/types.js';

// Real repository and routes: Adventure mode's endpoints, its settings, and the rule that it changes nothing else.
const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
let app: FastifyInstance;
let repo: Repo;
let now: number;
let todos: string[];

const send = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload === undefined ? {} : { payload: payload as never }) });
const claim = async (tz = 'UTC') => (await send('POST', '/api/rpg/claim', { tz })).json() as RpgClaim;

beforeEach(() => {
  now = Date.parse('2026-11-10T12:00:00.000Z');
  const clock = () => new Date(now);
  const db = openDb(':memory:');
  repo = createRepo(db, clock);
  todos = Array.from({ length: 20 }, (_, i) => repo.addTodo({ title: `todo ${i}`, notes: '', raw: '', dueAt: null }));
  now += 60_000;
  const bus = makeBus();
  app = buildApp({
    repo,
    engine: { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine,
    bus,
    quota: createQuotaTracker({ repo, getSettings: () => repo.getSettings(), clock }),
    poster: createHandoffPoster(repo),
    auth: fakeGoogleAuth(),
    addSource: async () => {
      throw new Error('unused');
    },
    testKey: async () => ({ ok: true, message: '' }),
    onSettingsChanged: () => {},
    resolveApiKey: () => ({ key: 'k', source: 'env' }),
    demo: false,
    rpg: createRpgReader(db, clock),
  });
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
    for (const id of todos.slice(0, 19)) {
      repo.triage([id], 'done'); // a todo pays 5: 95 XP is not a level yet
      now += 1000;
    }
    expect((await claim()).news.levelUp).toBeNull();
    repo.triage([todos[19]!], 'done');
    now += 1000;
    const c = await claim('America/New_York');
    expect(c.sheet).toMatchObject({ xp: 100, level: 2 });
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
