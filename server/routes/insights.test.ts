import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { AppDeps, Repo, SyncEngine } from '../contracts.js';
import { openDb, type Db } from '../db/db.js';
import { createInsightsReader } from '../db/insights.js';
import { createRepo } from '../db/repo.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeBus } from '../sync/test-helpers.js';
import { createQuotaTracker } from '../sync/quota.js';
import type { Insights } from '../../shared/insights.js';

// Real repository and routes: the Insights endpoint, its validation, and the rule that reading it changes nothing.
const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
let app: FastifyInstance;
let repo: Repo;
let db: Db;
let now: number;
let todos: string[];

const send = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = H) =>
  app.inject({ method, url, headers });

function build(withReader: boolean) {
  const clock = () => new Date(now);
  const deps: AppDeps = {
    repo,
    engine: { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine,
    bus: makeBus(),
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
    ...(withReader ? { insights: createInsightsReader(db, clock) } : {}),
  };
  return buildApp(deps);
}

beforeEach(() => {
  now = Date.parse('2026-11-10T12:00:00.000Z');
  db = openDb(':memory:');
  repo = createRepo(db, () => new Date(now));
  todos = Array.from({ length: 12 }, (_, i) => repo.addTodo({ title: `todo ${i}`, notes: '', raw: '', dueAt: null }));
  now += 60_000;
  app = build(true);
});
afterEach(() => app.close());

describe('GET /api/insights', () => {
  it('answers the report for the default range (30d) and the given zone', async () => {
    const res = await send('GET', '/api/insights?tz=Europe/London');
    expect(res.statusCode).toBe(200);
    const r = res.json() as Insights;
    expect(r).toMatchObject({ range: '30d', tz: 'Europe/London', days: 30 });
    expect(r.backlog.inboxAge.n).toBe(12);
    for (const range of ['7d', '30d', '90d', 'all'])
      expect((await send('GET', `/api/insights?range=${range}&tz=UTC`)).json().range).toBe(range);
  });

  it('refuses an unknown range or zone with a 400', async () => {
    expect((await send('GET', '/api/insights?range=1y')).statusCode).toBe(400);
    const tz = await send('GET', '/api/insights?tz=Not/AZone');
    expect(tz.statusCode).toBe(400);
    expect(tz.json().error ?? tz.json().message).toMatch(/time zone/i);
    expect((await send('GET', `/api/insights?tz=${'x'.repeat(65)}`)).statusCode).toBe(400);
  });

  it('is not there without a reader', async () => {
    await app.close();
    app = build(false);
    expect((await send('GET', '/api/insights')).statusCode).toBe(404);
  });

  it('changes nothing: inbox, counts, bootstrap and the database are identical before and after', async () => {
    repo.triage([todos[0]!], 'done');
    repo.snooze([todos[1]!], new Date(now + 86_400_000).toISOString());
    const snapshot = async () => {
      const out: unknown[] = [];
      for (const view of ['inbox', 'done', 'all', 'snoozed'])
        out.push((await send('GET', `/api/inbox?view=${view}`)).json());
      const boot = (await send('GET', '/api/bootstrap')).json();
      out.push(boot.counts, boot);
      return JSON.stringify(out);
    };
    const rows = () =>
      JSON.stringify([
        db.prepare('SELECT * FROM items ORDER BY id').all(),
        db.prepare('SELECT * FROM item_events ORDER BY id').all(),
        db.prepare('SELECT * FROM settings ORDER BY key').all(),
      ]);
    const before = await snapshot();
    const dbBefore = rows();
    for (const range of ['7d', '30d', '90d', 'all'])
      for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'])
        expect((await send('GET', `/api/insights?range=${range}&tz=${encodeURIComponent(tz)}`)).statusCode).toBe(200);
    expect(await snapshot()).toBe(before);
    expect(rows()).toBe(dbBefore);
  });
});
