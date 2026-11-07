import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGoogleAuth, SCOPE, TOKEN_URL } from '../auth/google.js';
import { buildApp } from '../app.js';
import type { GoogleClient } from '../config.js';
import { createHandoffPoster } from '../reply/poster.js';
import { makeEnv } from '../sync/test-helpers.js';
import type { GoogleAuthDTO } from '../../shared/types.js';

const HOST = '127.0.0.1:4517';
const H = { 'x-youtubey': '1', host: HOST };
const CH = 'UC' + 'm'.repeat(22);
const CLIENT: GoogleClient = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sek', source: 'env' };

let app: FastifyInstance;
let client: GoogleClient | null;

beforeEach(() => {
  client = CLIENT;
  const env = makeEnv({ settings: { ownChannelIds: [CH] } });
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: SCOPE }));
    }
    return new Response('{}');
  }) as unknown as typeof fetch;
  const auth = createGoogleAuth({
    repo: env.repo,
    gateway: { myChannel: async () => ({ id: CH, title: 'Mine', thumbnailUrl: null }) },
    getClient: () => client,
    redirectUri: () => `http://${HOST}/api/auth/callback`,
    fetchImpl,
  });
  app = buildApp(
    {
      repo: env.repo,
      engine: { run: vi.fn(), status: () => ({}) } as never,
      bus: env.bus,
      quota: env.quota,
      poster: createHandoffPoster(env.repo),
      auth,
      addSource: vi.fn() as never,
      testKey: async () => ({ ok: true, message: '' }),
      onSettingsChanged: () => {},
      resolveApiKey: () => ({ key: 'k', source: 'env' }),
      demo: false,
    },
    { port: 4517, extraOrigins: ['http://127.0.0.1:5173'] },
  );
});
afterEach(() => app.close());

const start = async (headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/start', headers: { ...H, ...headers }, payload: {} });
  return res;
};
const stateOf = (res: { json(): unknown }) => new URL((res.json() as { url: string }).url).searchParams.get('state')!;

describe('/api/auth/start', () => {
  it('returns the Google URL for the trusted Origin-less / same-origin request', async () => {
    const res = await start({ origin: `http://${HOST}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { url: string }).url).toContain('accounts.google.com');
  });

  it('is rejected without X-Youtubey (login-CSRF protection)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/start', headers: { host: HOST }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('is rejected from a foreign Origin', async () => {
    expect((await start({ origin: 'http://evil.example' })).statusCode).toBe(403);
  });

  it('400 no_client when no client is configured', async () => {
    client = null;
    const res = await start();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'no_client' });
  });
});

describe('/api/auth/callback', () => {
  it('passes security with a loopback Host and no X-Youtubey / Origin, and redirects home', async () => {
    const state = stateOf(await start({ origin: `http://${HOST}` }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=C&state=${state}`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`http://${HOST}/settings?google=connected`);
  });

  it('sends no-store and no-referrer so the code cannot leak', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/callback?code=C&state=x', headers: { host: HOST } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('is rejected for a non-loopback Host (DNS rebinding)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/callback?code=C&state=x',
      headers: { host: 'evil.com:4517' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns to the Vite dev origin that started the flow', async () => {
    const state = stateOf(await start({ origin: 'http://127.0.0.1:5173' }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?error=access_denied&state=${state}`,
      headers: { host: HOST },
    });
    expect(res.headers.location).toBe('http://127.0.0.1:5173/settings?google=denied');
  });

  it('unknown state redirects to its own host only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/callback?code=C&state=forged',
      headers: { host: HOST, origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings?google=bad_state');
  });
});

describe('status / logout / default', () => {
  it('connects, reports status, switches default and logs out', async () => {
    const state = stateOf(await start());
    await app.inject({ method: 'GET', url: `/api/auth/callback?code=C&state=${state}`, headers: { host: HOST } });

    const status = (
      await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: HOST } })
    ).json() as GoogleAuthDTO;
    expect(status.accounts).toMatchObject([{ channelId: CH, isDefault: true }]);
    expect(JSON.stringify(status)).not.toMatch(/sek|"R"|"A"/);

    const post = (url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers: H, payload: payload as never });
    expect((await post('/api/auth/default', { channelId: CH })).statusCode).toBe(200);
    expect((await post('/api/auth/default', { channelId: 'UCnope' })).statusCode).toBe(404);
    expect((await post('/api/auth/default', {})).statusCode).toBe(400);
    const out = await post('/api/auth/logout', {});
    expect(out.statusCode).toBe(200);
    expect((out.json() as GoogleAuthDTO).accounts).toEqual([]);
  });
});
