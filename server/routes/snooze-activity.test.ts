import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { GithubClient, GithubItemUpsert, SnoozeAi, SyncEngine } from '../contracts.js';
import { LlmError } from '../contracts.js';
import { githubItemId } from '../db/feeds.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeEnv } from '../sync/test-helpers.js';
import type { ServerEvent } from '../../shared/types.js';
import { MAX_BUCKET_CALLS } from './snoozeAi.js';

// Real repo behind the real routes: the until-activity options of POST /api/snooze, the per-bucket defaults in
// settings, the bucketing that follows a free-text why, and the nudge draft. The model and GitHub are fakes.
const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let events: ServerEvent[];
let bucketCalls: { why: string; title: string | null; kind: string; key: string; model: string }[];
let bucketAnswer: () => Promise<{
  bucket: 'waiting_on_them' | null;
  tokens: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number };
}>;
let nudgeCalls: Parameters<SnoozeAi['nudge']>[0][];
let nudgeAnswer: () => Promise<{
  text: string;
  tokens: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number };
}>;
let recent: GithubClient['recentComments'];

const id = (n: number) => githubItemId('org', 'app', n);
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, payload: payload as never });
const snooze = (payload: Record<string, unknown>) => send('POST', '/api/snooze', payload);
const settle = () => new Promise((r) => setTimeout(r, 20));
const items = () => env.repo.listInbox({ view: 'all' }).items;
const item = (n: number) => items().find((i) => i.item.id === id(n))!;
const tokens = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
const up = (n: number): GithubItemUpsert => ({
  id: id(n),
  kind: 'pr',
  repo: 'org/app',
  number: n,
  title: `Change ${n}`,
  author: 'carol',
  authorAvatarUrl: null,
  authorType: 'User',
  association: 'CONTRIBUTOR',
  bodyPlain: 'adds a thing',
  url: `https://github.com/org/app/pull/${n}`,
  createdAt: new Date(Date.now() - 3 * DAY).toISOString(),
  updatedAt: new Date().toISOString(),
  sourceState: 'open',
  draft: false,
  comments: 2,
  labels: [],
});

beforeEach(() => {
  env = makeEnv({});
  const feed = env.repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' });
  env.repo.upsertGithubItems(feed.id, [up(1), up(2), up(3)]);
  env.repo.triage([id(1), id(2), id(3)], 'inbox');
  env.repo.updateSettings({
    github: { token: 'tok', myAccounts: ['me'] },
    llm: { apiKey: 'sk', model: 'claude-haiku-5-5' },
  });
  events = [];
  env.bus.subscribe((e) => events.push(e));
  bucketCalls = [];
  bucketAnswer = async () => ({ bucket: 'waiting_on_them', tokens });
  nudgeCalls = [];
  nudgeAnswer = async () => ({ text: 'Still planning to pick this up?', tokens });
  recent = async () => [
    { author: 'carol', text: 'I will look at it', at: new Date().toISOString() },
    { author: 'Me', text: 'thanks', at: new Date().toISOString() },
  ];
  app = buildApp({
    repo: env.repo,
    engine: { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine,
    bus: env.bus,
    quota: env.quota,
    poster: createHandoffPoster(env.repo),
    auth: fakeGoogleAuth(),
    addSource: async () => {
      throw new Error('unused');
    },
    testKey: async () => ({ ok: true, message: '' }),
    onSettingsChanged: () => {},
    resolveApiKey: () => ({ key: 'k', source: 'env' }),
    demo: false,
    githubClient: {
      latestCommenter: async () => null,
      recentComments: (...a) => recent(...a),
    } as unknown as GithubClient,
    snoozeAi: {
      bucket: async (input, key, model) => {
        bucketCalls.push({ ...input, key, model });
        return bucketAnswer();
      },
      nudge: async (input) => {
        nudgeCalls.push(input);
        return nudgeAnswer();
      },
    },
  });
});
afterEach(() => app.close());

describe('POST /api/snooze with a bucket and until activity', () => {
  it('stores them, and uses the bucket default from settings when no date is given', async () => {
    const res = await snooze({ commentIds: [id(1)], untilActivity: true, bucket: 'waiting_on_merge' });
    expect(res.statusCode).toBe(200);
    const to = res.json().changes[0].to as string;
    // waiting_on_merge defaults to 3 days
    expect(Math.abs(Date.parse(to) - (Date.now() + 3 * DAY))).toBeLessThan(5_000);
    expect(item(1)).toMatchObject({ snoozeBucket: 'waiting_on_merge', snoozeUntilActivity: true, snoozedUntil: to });
  });

  it('follows the owner settings, and 7 days without a bucket', async () => {
    await send('PUT', '/api/settings', { snoozeDays: { waiting_on_merge: 10 } });
    const a = await snooze({ commentIds: [id(1)], untilActivity: true, bucket: 'waiting_on_merge' });
    expect(Math.abs(Date.parse(a.json().changes[0].to) - (Date.now() + 10 * DAY))).toBeLessThan(5_000);
    const b = await snooze({ commentIds: [id(2)], untilActivity: true });
    expect(Math.abs(Date.parse(b.json().changes[0].to) - (Date.now() + 7 * DAY))).toBeLessThan(5_000);
  });

  it('lets an explicit date be the fallback instead', async () => {
    const until = new Date(Date.now() + 2 * DAY).toISOString();
    const res = await snooze({ commentIds: [id(1)], untilActivity: true, bucket: 'in_flight', until });
    expect(res.json().changes[0].to).toBe(until);
    expect(item(1)).toMatchObject({ snoozeUntilActivity: true, snoozeBucket: 'in_flight' });
  });

  it('applies one choice to every id of a bulk snooze', async () => {
    const res = await snooze({ commentIds: [id(1), id(2), id(3)], untilActivity: true, bucket: 'lower_priority' });
    expect(res.json().changes).toHaveLength(3);
    for (const n of [1, 2, 3])
      expect(item(n)).toMatchObject({ snoozeBucket: 'lower_priority', snoozeUntilActivity: true });
    const tos = new Set(res.json().changes.map((c: { to: string }) => c.to));
    expect(tos.size).toBe(1);
  });

  it('never accepts an until-activity snooze without a fallback: a past or far date is still rejected', async () => {
    for (const until of [new Date(Date.now() - HOUR).toISOString(), new Date(Date.now() + 400 * DAY).toISOString()]) {
      const res = await snooze({ commentIds: [id(1)], untilActivity: true, until });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('bad_until');
    }
    expect(item(1).snoozedUntil).toBeNull();
  });

  it('rejects an unknown bucket and a non-boolean flag, and ignores both when unsnoozing', async () => {
    expect((await snooze({ commentIds: [id(1)], untilActivity: true, bucket: 'whenever' })).statusCode).toBe(400);
    expect((await snooze({ commentIds: [id(1)], untilActivity: 'yes', until: null })).statusCode).toBe(400);
    await snooze({ commentIds: [id(1)], until: new Date(Date.now() + HOUR).toISOString() });
    const un = await snooze({ commentIds: [id(1)], until: null, bucket: 'in_flight', untilActivity: true });
    expect(un.statusCode).toBe(200);
    expect(item(1)).toMatchObject({ snoozedUntil: null, snoozeUntilActivity: false });
  });

  it('is undoable', async () => {
    const res = await snooze({ commentIds: [id(1)], untilActivity: true, bucket: 'in_flight' });
    await send('POST', `/api/snooze/${res.json().actionId}/undo`);
    expect(item(1)).toMatchObject({ snoozedUntil: null, snoozeBucket: null, snoozeUntilActivity: false });
  });
});

describe('settings: snooze days per bucket', () => {
  it('has the defaults, saves a change for one bucket and keeps the others, and tells other tabs', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/settings', headers: { host: H.host } })).json().snoozeDays,
    ).toEqual({
      waiting_on_them: 7,
      waiting_on_merge: 3,
      in_flight: 7,
      lower_priority: 30,
    });
    const res = await send('PUT', '/api/settings', { snoozeDays: { waiting_on_them: 14 } });
    expect(res.json().snoozeDays).toEqual({
      waiting_on_them: 14,
      waiting_on_merge: 3,
      in_flight: 7,
      lower_priority: 30,
    });
    expect(events.find((e) => e.type === 'settings.changed')).toMatchObject({
      settings: { snoozeDays: { waiting_on_them: 14 } },
    });
  });

  it.each([[0], [366], [1.5], ['soon'], [null], [-3]])('rejects %s days', async (days) => {
    const res = await send('PUT', '/api/settings', { snoozeDays: { in_flight: days } });
    expect(res.statusCode).toBe(400);
    expect(env.repo.getSettings().snoozeDays.in_flight).toBe(7);
  });

  it('accepts the limits, 1 and 365, and rejects an unknown bucket', async () => {
    expect((await send('PUT', '/api/settings', { snoozeDays: { in_flight: 1, lower_priority: 365 } })).statusCode).toBe(
      200,
    );
    expect((await send('PUT', '/api/settings', { snoozeDays: { everything: 5 } })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings', { snoozeDays: 7 })).statusCode).toBe(400);
  });
});

describe('bucketing a free-text why', () => {
  it('assigns the bucket after the snooze has answered, records that it was automatic, and counts the cost', async () => {
    const res = await snooze({
      commentIds: [id(1)],
      until: new Date(Date.now() + DAY).toISOString(),
      why: 'wait for the reporter to reply',
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(item(1).snoozeBucket).toBe('waiting_on_them'));
    expect(bucketCalls).toEqual([
      { why: 'wait for the reporter to reply', title: 'Change 1', kind: 'pr', key: 'sk', model: 'claude-haiku-5-5' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'inbox.changed', changedIds: [id(1)] });
    expect(env.repo.usage.today('snooze_ai.call')).toBe(1);
    expect(env.repo.usage.today('snooze_ai.cost_micros')).toBeGreaterThan(0);
    // The cap's own ledger has it too, in the same micro-dollars the usage page shows.
    expect(env.repo.spend.todayUsd() * 1e6).toBeCloseTo(env.repo.usage.today('snooze_ai.cost_micros'));
  });

  it('does nothing when a bucket was chosen, when there is no why, or when the model is unsure', async () => {
    const until = new Date(Date.now() + DAY).toISOString();
    await snooze({ commentIds: [id(1)], until, why: 'x', bucket: 'in_flight' });
    await snooze({ commentIds: [id(2)], until });
    bucketAnswer = async () => ({ bucket: null, tokens });
    await snooze({ commentIds: [id(3)], until, why: 'something vague' });
    await settle();
    expect(bucketCalls).toHaveLength(1); // only the vague one was asked
    expect(item(1).snoozeBucket).toBe('in_flight');
    expect(item(2).snoozeBucket).toBeNull();
    expect(item(3).snoozeBucket).toBeNull();
  });

  it('is a no-op without a key, and never fails or delays the snooze when the model fails', async () => {
    env.repo.updateSettings({ llm: { apiKey: null, model: 'claude-haiku-5-5' } });
    const until = new Date(Date.now() + DAY).toISOString();
    expect((await snooze({ commentIds: [id(1)], until, why: 'wait for them' })).statusCode).toBe(200);
    await settle();
    expect(bucketCalls).toEqual([]);

    env.repo.updateSettings({ llm: { apiKey: 'sk', model: 'claude-haiku-5-5' } });
    bucketAnswer = async () => {
      throw new LlmError('Anthropic said 500');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await snooze({ commentIds: [id(2)], until, why: 'wait for them' });
      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(env.repo.usage.today('snooze_ai.fail')).toBe(1));
      expect(item(2)).toMatchObject({ snoozedUntil: until, snoozeBucket: null });
      // Said somewhere the owner can see it in the server log (the request logger is switched off).
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain('snooze bucketing failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('drops the bucket if the snooze was undone or replaced while the model was thinking', async () => {
    let release!: () => void;
    bucketAnswer = () => new Promise((r) => (release = () => r({ bucket: 'waiting_on_them', tokens })));
    const until = new Date(Date.now() + DAY).toISOString();
    const res = await snooze({ commentIds: [id(1)], until, why: 'wait for them' });
    await vi.waitFor(() => expect(bucketCalls).toHaveLength(1));
    await send('POST', `/api/snooze/${res.json().actionId}/undo`);
    release();
    await settle();
    expect(item(1).snoozeBucket).toBeNull();
  });

  it('stops at the daily cost cap, and caps the calls of one bulk snooze', async () => {
    const feed = env.repo.listFeeds()[0]!;
    const many = Array.from({ length: MAX_BUCKET_CALLS + 5 }, (_, i) => up(100 + i));
    env.repo.upsertGithubItems(feed.id, many);
    env.repo.triage(
      many.map((m) => m.id),
      'inbox',
    );
    await snooze({ commentIds: many.map((m) => m.id), until: new Date(Date.now() + DAY).toISOString(), why: 'wait' });
    await vi.waitFor(() => expect(bucketCalls).toHaveLength(MAX_BUCKET_CALLS));
    await settle();
    expect(bucketCalls).toHaveLength(MAX_BUCKET_CALLS);

    bucketCalls.length = 0;
    env.repo.spend.add('snooze_ai', 3_000_000); // $3 today, over the $2 cap
    await snooze({ commentIds: [id(1)], until: new Date(Date.now() + 2 * DAY).toISOString(), why: 'wait' });
    await settle();
    expect(bucketCalls).toEqual([]);
  });

  it('stays capped after "Reset usage data", which must not erase what was spent', async () => {
    env.repo.spend.add('snooze_ai', 3_000_000);
    expect((await send('DELETE', '/api/usage')).statusCode).toBe(204);
    await snooze({ commentIds: [id(1)], until: new Date(Date.now() + 2 * DAY).toISOString(), why: 'wait' });
    await settle();
    expect(bucketCalls).toEqual([]);
  });
});

describe('POST /api/items/:id/nudge-draft', () => {
  const park = async (n: number, bucket: 'waiting_on_them' | 'in_flight' = 'waiting_on_them') => {
    env.repo.snooze([id(n)], new Date(env.clock.now().getTime() + HOUR).toISOString(), 'waiting for carol', {
      bucket,
      untilActivity: true,
    });
    // The fallback arrives with nothing on the thread.
    env.clock.advance(2 * HOUR);
    env.repo.wakeSnoozed();
  };

  it('drafts a short comment from the thread, treating it as data, and posts nothing', async () => {
    await park(1);
    const res = await send('POST', `/api/items/${encodeURIComponent(id(1))}/nudge-draft`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Still planning to pick this up?', bucket: 'Waiting on them' });
    expect(nudgeCalls).toHaveLength(1);
    expect(nudgeCalls[0]).toMatchObject({
      title: 'Change 1',
      kind: 'pr',
      bucket: 'waiting_on_them',
      why: 'waiting for carol',
      body: 'adds a thing',
      comments: [
        { author: 'carol', isMatt: false, text: 'I will look at it' },
        { author: 'Me', isMatt: true, text: 'thanks' },
      ],
    });
    expect(env.repo.usage.today('snooze_ai.call')).toBe(1);
  });

  it('still drafts from the description when GitHub cannot be reached', async () => {
    await park(1);
    recent = async () => {
      throw new Error('rate limited');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await send('POST', `/api/items/${encodeURIComponent(id(1))}/nudge-draft`)).statusCode).toBe(200);
      expect(nudgeCalls[0]!.comments).toEqual([]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain('nudge: could not fetch comments');
    } finally {
      warn.mockRestore();
    }
  });

  it('only applies to a GitHub item that came back from a waiting_on_* snooze with no activity', async () => {
    await park(1, 'in_flight');
    expect((await send('POST', `/api/items/${encodeURIComponent(id(1))}/nudge-draft`)).json().code).toBe(
      'not_applicable',
    );
    expect((await send('POST', `/api/items/${encodeURIComponent(id(2))}/nudge-draft`)).statusCode).toBe(409); // never snoozed
    expect((await send('POST', `/api/items/${encodeURIComponent(id(999))}/nudge-draft`)).statusCode).toBe(404);
    expect(nudgeCalls).toEqual([]);
  });

  it('says so when there is no key, when the daily cap is spent, and when the model fails', async () => {
    await park(1);
    env.repo.updateSettings({ llm: { apiKey: null, model: 'claude-haiku-5-5' } });
    let res = await send('POST', `/api/items/${encodeURIComponent(id(1))}/nudge-draft`);
    expect([res.statusCode, res.json().code]).toEqual([424, 'no_key']);
    env.repo.updateSettings({ llm: { apiKey: 'sk', model: 'claude-haiku-5-5' } });
    env.repo.spend.add('assistant', 3_000_000);
    res = await send('POST', `/api/items/${encodeURIComponent(id(1))}/nudge-draft`);
    expect([res.statusCode, res.json().code]).toEqual([429, 'cap']);
    expect(nudgeCalls).toEqual([]);
  });

  it('reports a model failure as 424 without leaking details beyond the message', async () => {
    await park(1);
    nudgeAnswer = async () => {
      throw new LlmError('Anthropic said 500');
    };
    const res = await send('POST', `/api/items/${encodeURIComponent(id(1))}/nudge-draft`);
    expect([res.statusCode, res.json().code]).toEqual([424, 'llm_failed']);
  });
});
