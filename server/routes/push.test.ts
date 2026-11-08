import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { PushService, SyncEngine } from '../contracts.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeEnv } from '../sync/test-helpers.js';

const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
const EP = 'https://fcm.googleapis.com/fcm/send/abc';
const SUB = { endpoint: EP, keys: { p256dh: 'BPk', auth: 'au' } };

let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let testCalls: string[];

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: H, payload: payload as never });

function build(push: PushService | undefined) {
  env = makeEnv({});
  testCalls = [];
  const engine = { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine;
  app = buildApp({
    repo: env.repo,
    engine,
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
    push,
  });
}
const fakePush = (): PushService => ({
  publicKey: () => 'PUBKEY',
  async test(endpoint) {
    testCalls.push(endpoint);
    return env.repo.getPushSubscription(endpoint) ? 'ok' : 'unknown';
  },
  async flush() {},
  stop() {},
});

afterEach(() => app.close());

describe('push routes', () => {
  beforeEach(() => build(fakePush()));

  it('serves the public key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/push/config', headers: { host: H.host } });
    expect(res.json()).toEqual({ publicKey: 'PUBKEY' });
  });

  it('reports an unsubscribed device with default prefs', async () => {
    const res = await post('/api/push/state', { endpoint: EP });
    expect(res.json()).toEqual({ subscribed: false, prefs: { newComments: true, snoozeWake: true } });
  });

  it('subscribes, keeps prefs on re-subscribe, and updates them', async () => {
    let res = await post('/api/push/subscribe', { subscription: SUB, label: 'Pixel' });
    expect(res.json()).toEqual({ subscribed: true, prefs: { newComments: true, snoozeWake: true } });

    res = await post('/api/push/subscribe', { subscription: SUB, prefs: { snoozeWake: false } });
    expect(res.json().prefs).toEqual({ newComments: true, snoozeWake: false });

    // Re-subscribing without prefs (browser rotated keys) must not reset them, or the label.
    res = await post('/api/push/subscribe', { subscription: { ...SUB, keys: { p256dh: 'new', auth: 'au2' } } });
    expect(res.json().prefs).toEqual({ newComments: true, snoozeWake: false });
    const row = env.repo.getPushSubscription(EP)!;
    expect(row).toMatchObject({ p256dh: 'new', auth: 'au2', label: 'Pixel' });
  });

  it('unsubscribes', async () => {
    await post('/api/push/subscribe', { subscription: SUB });
    expect((await post('/api/push/unsubscribe', { endpoint: EP })).statusCode).toBe(204);
    expect(env.repo.listPushSubscriptions()).toHaveLength(0);
  });

  it('sends a test only to a subscribed device', async () => {
    expect((await post('/api/push/test', { endpoint: EP })).statusCode).toBe(404);
    await post('/api/push/subscribe', { subscription: SUB });
    const res = await post('/api/push/test', { endpoint: EP });
    expect(res.json()).toEqual({ result: 'ok' });
    expect(testCalls.at(-1)).toBe(EP);
  });

  it.each([
    ['an internal address', { endpoint: 'https://169.254.169.254/x', keys: SUB.keys }],
    ['plain http', { endpoint: 'http://fcm.googleapis.com/x', keys: SUB.keys }],
    ['missing keys', { endpoint: EP }],
    ['oversized keys', { endpoint: EP, keys: { p256dh: 'x'.repeat(500), auth: 'a' } }],
  ])('rejects a subscription with %s', async (_n, subscription) => {
    const res = await post('/api/push/subscribe', { subscription });
    expect(res.statusCode).toBe(400);
    expect(env.repo.listPushSubscriptions()).toHaveLength(0);
  });

  it('requires the client header like every other write', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { host: H.host },
      payload: { subscription: SUB },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('push routes when push is unavailable', () => {
  beforeEach(() => build(undefined));
  it('answers 503 push_unavailable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/push/config', headers: { host: H.host } });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('push_unavailable');
  });
});
