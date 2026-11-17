import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { AppDeps } from '../contracts.js';
import { makeEnv } from '../sync/test-helpers.js';
import { CLIENT_USAGE_KEYS, MAX_COUNT_PER_KEY, MAX_KEYS_PER_REQUEST } from '../../shared/usage.js';
import { H, sender, testDeps } from './test-helpers.js';

let env: ReturnType<typeof makeEnv>;
let deps: AppDeps;
let app: FastifyInstance;

const send = sender(() => app);
const rows = () => env.repo.usage.report(1).rows;

beforeEach(() => {
  env = makeEnv({});
  deps = testDeps(env.repo, { bus: env.bus, quota: env.quota });
  app = buildApp(deps, { port: 4517 });
});
afterEach(() => app.close());

describe('POST /api/usage', () => {
  it('adds batched counts, accumulating across requests', async () => {
    const a = await send('POST', '/api/usage', { counts: { 'done.kbd': 2, 'view.stats': 1 } });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ accepted: 2, rejected: [] });
    await send('POST', '/api/usage', { counts: { 'done.kbd': 3 } });
    expect(rows().map((r) => [r.key, r.count])).toEqual([
      ['done.kbd', 5],
      ['view.stats', 1],
    ]);
  });

  it('drops unknown keys and reports them without storing', async () => {
    const r = await send('POST', '/api/usage', {
      counts: { 'done.kbd': 1, 'search.run:cats': 7, 'assistant.cost_micros': 5 },
    });
    expect(r.json()).toEqual({ accepted: 1, rejected: ['search.run:cats', 'assistant.cost_micros'] });
    expect(rows().map((x) => x.key)).toEqual(['done.kbd']);
  });

  it('caps counts per key and keys per request', async () => {
    const r = await send('POST', '/api/usage', { counts: { 'done.kbd': MAX_COUNT_PER_KEY + 1, 'done.btn': 1 } });
    expect(r.json()).toEqual({ accepted: 1, rejected: ['done.kbd'] });
    const many = Object.fromEntries(Array.from({ length: MAX_KEYS_PER_REQUEST + 1 }, (_, i) => [`k${i}`, 1]));
    expect((await send('POST', '/api/usage', { counts: many })).statusCode).toBe(400);
    // The cap must always leave room for a report that carries every key a browser may send.
    expect(CLIENT_USAGE_KEYS.length).toBeLessThanOrEqual(MAX_KEYS_PER_REQUEST);
  });

  it('rejects malformed bodies', async () => {
    for (const body of [{}, { counts: [] }, { counts: 'x' }, []]) {
      expect((await send('POST', '/api/usage', body)).statusCode).toBe(400);
    }
  });
});

describe('GET /api/usage', () => {
  it('returns rows, event-log counts and unused features for the window', async () => {
    await send('POST', '/api/usage', { counts: { 'done.kbd': 4 } });
    env.repo.usage.add({});
    const r = await send('GET', '/api/usage?days=7');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.days).toBe(7);
    expect(body.rows).toEqual([expect.objectContaining({ key: 'done.kbd', count: 4 })]);
    expect(body.events).toEqual([]);
    expect(body.unused).toContain('snooze');
    expect(body.unused).not.toContain('done');
  });

  it('validates days', async () => {
    expect((await send('GET', '/api/usage')).json().days).toBe(30);
    for (const d of ['0', '400', 'x']) expect((await send('GET', `/api/usage?days=${d}`)).statusCode).toBe(400);
  });
});

describe('DELETE /api/usage', () => {
  it('deletes the counters', async () => {
    await send('POST', '/api/usage', { counts: { 'done.kbd': 1 } });
    expect((await send('DELETE', '/api/usage')).statusCode).toBe(204);
    expect(rows()).toEqual([]);
  });
});

describe('security', () => {
  it('rejects a foreign Host on every verb', async () => {
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const r = await send(method, '/api/usage', { counts: {} }, { ...H, host: 'evil.example:4517' });
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe('bad_host');
    }
  });

  it('rejects writes without the client header or from a foreign origin', async () => {
    const noHeader = await send('POST', '/api/usage', { counts: { 'done.kbd': 1 } }, { host: H.host });
    expect(noHeader.json().code).toBe('missing_client_header');
    const evil = await send(
      'POST',
      '/api/usage',
      { counts: { 'done.kbd': 1 } },
      { ...H, origin: 'https://evil.example' },
    );
    expect(evil.json().code).toBe('bad_origin');
    expect((await send('DELETE', '/api/usage', undefined, { host: H.host })).statusCode).toBe(403);
    expect(rows()).toEqual([]);
  });

  it('requires a verified Access user on an Access host', async () => {
    const proxied = buildApp(deps, {
      accessHosts: ['nudge.example.com'],
      allowedUsers: ['me@example.com'],
      verifyAccess: async (t) => (t === 'good' ? 'me@example.com' : null),
    });
    const headers = { 'x-nudge': '1', host: 'nudge.example.com' };
    expect((await proxied.inject({ method: 'GET', url: '/api/usage', headers })).statusCode).toBe(403);
    const ok = await proxied.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { ...headers, 'cf-access-jwt-assertion': 'good' },
    });
    expect(ok.statusCode).toBe(200);
    await proxied.close();
  });
});

describe('assistant counters', () => {
  it('records calls, tool calls, failures and cost as counts, never the words', async () => {
    env.repo.updateSettings({
      llm: { apiKey: 'sk-test', model: 'claude-sonnet-5-5' },
      owner: { name: 'Priya', about: 'Maintains a parser.' },
    });
    let fail = false;
    const llmApp = buildApp(
      {
        ...deps,
        llm: {
          test: async () => ({ ok: true, message: '' }),
          command: async () => {
            if (fail) throw new Error('boom secret words');
            return {
              actions: [{ type: 'add_todo', title: 'Ring the plumber', notes: '', due: null }],
              reply: '',
              tokens: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
            };
          },
        },
      },
      { port: 4517 },
    );
    const post = (text: string) =>
      llmApp.inject({ method: 'POST', url: '/api/assistant', headers: H, payload: { text } as never });
    await post('ring the plumber about my secret leak');
    fail = true;
    await post('another secret');
    await llmApp.close();

    const got = Object.fromEntries(rows().map((r) => [r.key, r.count]));
    expect(got).toEqual({
      'assistant.call': 2,
      'assistant.tool_call': 1,
      'assistant.fail': 1,
      'assistant.cost_micros': 3000, // 1000 in x $2/M + 100 out x $10/M = $0.003
    });
    expect(JSON.stringify(env.repo.usage.report(1))).not.toContain('secret');
  });
});
