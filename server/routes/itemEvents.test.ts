import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { openDb, type Db } from '../db/db.js';
import { createRepo } from '../db/repo.js';
import { makeEnv } from '../sync/test-helpers.js';
import { MAX_ITEM_EVENTS_PER_REQUEST } from '../../shared/api.js';
import { H, testDeps } from './test-helpers.js';

let db: Db;
let app: FastifyInstance;

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/item-events', headers: H, payload: payload as never });
const rows = () =>
  (
    db
      .prepare('SELECT item_id, at, kind, from_value, to_value, source, meta FROM item_events ORDER BY id')
      .all() as any[]
  ).map(
    // eslint-disable-line @typescript-eslint/no-explicit-any
    (r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }),
  );

beforeEach(() => {
  const env = makeEnv({});
  db = openDb(':memory:');
  const repo = createRepo(db);
  for (const id of ['a', 'b']) {
    db.prepare(
      `INSERT INTO items (id, provider, kind, occurred_at, state, state_source, state_changed_at, first_seen_at)
       VALUES (?, 'youtube', 'comment', '2026-01-01T00:00:00Z', 'inbox', 'sync', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(id);
  }
  const deps = testDeps(repo, { bus: env.bus, quota: env.quota });
  app = buildApp(deps, { port: 4517 });
});
afterEach(() => app.close());

describe('POST /api/item-events', () => {
  it('stores a decision and an open as user events with cleaned meta', async () => {
    const r = await post({
      events: [
        {
          kind: 'decision',
          itemId: 'a',
          to: 'done',
          meta: {
            view: 'inbox',
            rank: 3,
            listSize: 40,
            above: ['x', 'y'],
            input: 'key',
            bulk: false,
            selectionSize: 1,
          },
        },
        { kind: 'open', itemId: 'b', to: 'inbox', meta: { dwellMs: 4200, input: 'button' } },
      ],
    });
    expect(r.json()).toEqual({ accepted: 2, rejected: 0 });
    const [d, o] = rows();
    expect(d).toMatchObject({ item_id: 'a', kind: 'decision', from_value: null, to_value: 'done', source: 'user' });
    expect(d.meta).toEqual({
      view: 'inbox',
      rank: 3,
      listSize: 40,
      above: ['x', 'y'],
      input: 'key',
      bulk: false,
      selectionSize: 1,
    });
    expect(o).toMatchObject({ kind: 'open', to_value: 'inbox', meta: { dwellMs: 4200, input: 'button' } });
  });

  it('skips unknown items silently and counts them', async () => {
    const r = await post({
      events: [
        { kind: 'open', itemId: 'nope' },
        { kind: 'open', itemId: 'a' },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ accepted: 1, rejected: 1 });
    expect(rows()).toHaveLength(1);
  });

  it('rejects bad kinds and shapes per event, and malformed bodies outright', async () => {
    const r = await post({
      events: [{ kind: 'state', itemId: 'a' }, { kind: 'open' }, 7, { kind: 'open', itemId: 'a' }],
    });
    expect(r.json()).toEqual({ accepted: 1, rejected: 3 });
    expect((await post({ events: 'x' })).statusCode).toBe(400);
    expect((await post([])).statusCode).toBe(400);
  });

  it('caps the batch at the maximum', async () => {
    const ok = Array.from({ length: MAX_ITEM_EVENTS_PER_REQUEST }, () => ({ kind: 'open', itemId: 'a' }));
    expect((await post({ events: ok })).json()).toEqual({ accepted: MAX_ITEM_EVENTS_PER_REQUEST, rejected: 0 });
    const r = await post({ events: [...ok, { kind: 'open', itemId: 'a' }] });
    expect(r.statusCode).toBe(400);
    expect(rows()).toHaveLength(MAX_ITEM_EVENTS_PER_REQUEST);
  });

  it('drops meta keys and values outside the allow-list', async () => {
    await post({
      events: [
        {
          kind: 'decision',
          itemId: 'a',
          to: 'done',
          meta: {
            view: 'x'.repeat(100),
            rank: -1,
            listSize: Infinity,
            above: [...Array.from({ length: 15 }, (_, i) => `id${i}`), 5, 'z'.repeat(201)],
            input: 'telepathy',
            dwellMs: 7_200_000,
            text: 'secret comment',
            bulk: 'yes',
          },
        },
      ],
    });
    const m = rows()[0].meta;
    expect(m).toEqual({ above: Array.from({ length: 10 }, (_, i) => `id${i}`) });
    expect(JSON.stringify(rows())).not.toContain('secret comment');
  });

  it('uses the server clock for an `at` that is stale, in the future or garbage', async () => {
    const t0 = Date.now();
    const recent = new Date(t0 - 3_600_000).toISOString();
    await post({
      events: [
        { kind: 'open', itemId: 'a', at: recent },
        { kind: 'open', itemId: 'a', at: new Date(t0 - 25 * 3_600_000).toISOString() },
        { kind: 'open', itemId: 'a', at: new Date(t0 + 3_600_000).toISOString() },
        { kind: 'open', itemId: 'a', at: 'tomorrow' },
      ],
    });
    const ats = rows().map((r) => r.at);
    expect(ats[0]).toBe(recent);
    for (const a of ats.slice(1)) expect(Math.abs(Date.parse(a) - t0)).toBeLessThan(5000);
  });

  it('requires the client header', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/item-events',
      headers: { host: H.host },
      payload: { events: [] },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });
});
