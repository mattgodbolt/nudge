import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGoogleClient, type Config, type GoogleClient } from '../config.js';
import { PostError, type PostGateway, type Repo } from '../contracts.js';
import { openDb } from '../db/db.js';
import { createRepo } from '../db/repo.js';
import { makeClock } from '../sync/test-helpers.js';
import { AUTH_URL, createGoogleAuth, SCOPE, TOKEN_URL, REVOKE_URL } from './google.js';

const CLIENT: GoogleClient = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sek', source: 'settings' };
const REDIRECT = 'http://127.0.0.1:4517/api/auth/callback';
const CH = 'UC' + 'm'.repeat(22);
const CH2 = 'UC' + 'n'.repeat(22);

interface Call {
  url: string;
  body: URLSearchParams;
}

function setup(over: { client?: GoogleClient | null } = {}) {
  const repo: Repo = createRepo(openDb(':memory:'));
  const clock = makeClock();
  const calls: Call[] = [];
  const state = {
    token: { ok: true, status: 200, json: {} as Record<string, unknown> },
    revokeFails: false,
    refreshDelay: null as Promise<void> | null,
  };
  const goodToken = (extra: Record<string, unknown> = {}) => ({
    access_token: 'AT1',
    refresh_token: 'RT1',
    expires_in: 3600,
    scope: SCOPE,
    ...extra,
  });
  state.token.json = goodToken();
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: new URLSearchParams(String(init?.body ?? '')) });
    if (u.startsWith(REVOKE_URL)) {
      if (state.revokeFails) throw new Error('offline');
      return new Response('{}', { status: 200 });
    }
    if (u === TOKEN_URL) {
      if (state.refreshDelay) await state.refreshDelay;
      return new Response(JSON.stringify(state.token.json), { status: state.token.status });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  const gateway: Pick<PostGateway, 'myChannel'> = {
    myChannel: vi.fn(async () => ({ id: CH, title: 'Mine', thumbnailUrl: 'http://t/x' })) as never,
  };
  const onChange = vi.fn();
  const addSource = vi.fn(async () => ({}) as never);
  const quota = { charge: vi.fn() };
  const client = over.client === undefined ? CLIENT : over.client;
  const auth = createGoogleAuth({
    repo,
    gateway,
    getClient: () => client,
    redirectUri: () => REDIRECT,
    fetchImpl,
    clock: clock.now,
    onChange,
    addSource,
    quota,
  });
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const connect = async (origin = 'http://127.0.0.1:4517') => {
    const { url } = auth.start(origin);
    return auth.handleCallback({ code: 'CODE', state: stateOf(url) });
  };
  return {
    repo,
    clock,
    calls,
    state,
    goodToken,
    fetchImpl,
    gateway,
    onChange,
    addSource,
    quota,
    auth,
    stateOf,
    connect,
  };
}

const b64url = (b: Buffer) => b.toString('base64url');

describe('start', () => {
  it('builds the auth URL with every required parameter and a matching PKCE challenge', async () => {
    const t = setup();
    const { url } = t.auth.start('http://127.0.0.1:4517');
    expect(url.startsWith(AUTH_URL + '?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPE,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent select_account',
    });
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(43);
    // The verifier is sent at token exchange; its sha256 must equal the challenge from the URL.
    await t.auth.handleCallback({ code: 'C', state: q.get('state')! });
    const verifier = t.calls[0]!.body.get('code_verifier')!;
    expect(verifier).toHaveLength(64);
    expect(b64url(createHash('sha256').update(verifier).digest())).toBe(q.get('code_challenge'));
  });

  it('throws no_client without a configured client', () => {
    const t = setup({ client: null });
    expect(() => t.auth.start('http://x')).toThrowError(expect.objectContaining({ code: 'no_client' }));
  });

  it('state is single-use', async () => {
    const t = setup();
    const { url } = t.auth.start('http://127.0.0.1:4517');
    const state = t.stateOf(url);
    expect((await t.auth.handleCallback({ code: 'C', state })).result).toBe('connected');
    expect((await t.auth.handleCallback({ code: 'C', state })).result).toBe('bad_state');
  });

  it('state expires after 10 minutes', async () => {
    const t = setup();
    const state = t.stateOf(t.auth.start('http://127.0.0.1:4517').url);
    t.clock.advance(10 * 60_000 + 1);
    const r = await t.auth.handleCallback({ code: 'C', state });
    expect(r.result).toBe('bad_state');
    expect(t.calls).toHaveLength(0);
  });

  it('caps pending states at 5, dropping the oldest', async () => {
    const t = setup();
    const states = Array.from({ length: 6 }, () => t.stateOf(t.auth.start('http://127.0.0.1:4517').url));
    expect((await t.auth.handleCallback({ code: 'C', state: states[0] })).result).toBe('bad_state');
    expect((await t.auth.handleCallback({ code: 'C', state: states[5] })).result).toBe('connected');
  });
});

describe('handleCallback', () => {
  it('stores tokens, registers ownership, tracks the channel, charges quota and notifies', async () => {
    const t = setup();
    t.repo.updateSettings({ ownChannelIds: [] });
    const r = await t.connect('http://127.0.0.1:5173');
    expect(r).toEqual({ result: 'connected', returnTo: 'http://127.0.0.1:5173/settings?google=connected' });
    const tokenCall = t.calls[0]!;
    expect(tokenCall.body.get('grant_type')).toBe('authorization_code');
    expect(tokenCall.body.get('redirect_uri')).toBe(REDIRECT);
    expect(tokenCall.body.get('client_secret')).toBe('sek');
    expect(t.repo.listGoogleAccounts()).toMatchObject([
      { channelId: CH, title: 'Mine', refreshToken: 'RT1', accessToken: 'AT1', scope: SCOPE, isDefault: true },
    ]);
    expect(t.repo.getSettings().ownChannelIds).toEqual([CH]);
    expect(t.addSource).toHaveBeenCalledWith(CH, { isOwn: true, importMode: 'recent' });
    expect(t.quota.charge).toHaveBeenCalledWith('channels.list', 1);
    expect(t.onChange).toHaveBeenCalledTimes(1);
    expect(t.auth.canPost()).toBe(true);
  });

  it('does not add a source when the user already has an own channel', async () => {
    const t = setup();
    t.repo.updateSettings({ ownChannelIds: [CH2] });
    await t.connect();
    expect(t.addSource).not.toHaveBeenCalled();
    expect(t.repo.getSettings().ownChannelIds).toEqual([CH2, CH]);
  });

  it('still connects when tracking the channel fails', async () => {
    const t = setup();
    t.addSource.mockRejectedValueOnce(new Error('no key'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await t.connect()).result).toBe('connected');
  });

  it('maps access_denied to denied, returning to the originating UI', async () => {
    const t = setup();
    const state = t.stateOf(t.auth.start('http://127.0.0.1:5173').url);
    expect(await t.auth.handleCallback({ error: 'access_denied', state })).toEqual({
      result: 'denied',
      returnTo: 'http://127.0.0.1:5173/settings?google=denied',
    });
    expect(t.calls).toHaveLength(0);
  });

  it('unknown state returns a relative path so it can never leave its own host', async () => {
    const t = setup();
    expect(await t.auth.handleCallback({ code: 'C', state: 'nope' })).toEqual({
      result: 'bad_state',
      returnTo: '/settings?google=bad_state',
    });
    expect((await t.auth.handleCallback({})).returnTo).toBe('/settings?google=bad_state');
  });

  it('fails with scope_missing when the YouTube box was unticked, storing nothing', async () => {
    const t = setup();
    t.state.token.json = t.goodToken({ scope: 'openid' });
    expect((await t.connect()).result).toBe('scope_missing');
    expect(t.repo.listGoogleAccounts()).toEqual([]);
  });

  it('fails with no_channel when channels.list returns nothing', async () => {
    const t = setup();
    (t.gateway.myChannel as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect((await t.connect()).result).toBe('no_channel');
    expect(t.repo.listGoogleAccounts()).toEqual([]);
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it('fails with token_exchange_failed on a rejected code or missing refresh token', async () => {
    const t = setup();
    t.state.token = { ok: false, status: 400, json: { error: 'invalid_grant' } };
    expect((await t.connect()).result).toBe('token_exchange_failed');
    t.state.token = { ok: true, status: 200, json: { access_token: 'x', scope: SCOPE } };
    expect((await t.connect()).result).toBe('token_exchange_failed');
  });

  it('keeps the default flag when reconnecting and makes the first account default', async () => {
    const t = setup();
    await t.connect();
    await t.connect();
    expect(t.repo.listGoogleAccounts()).toHaveLength(1);
    expect(t.repo.listGoogleAccounts()[0]!.isDefault).toBe(true);
  });
});

describe('getAccessToken', () => {
  it('reuses a cached token and refreshes inside the 60 second margin', async () => {
    const t = setup();
    await t.connect();
    t.calls.length = 0;
    expect((await t.auth.getAccessToken()).token).toBe('AT1');
    expect(t.calls).toHaveLength(0);

    t.clock.advance(3600_000 - 60_000 - 1); // 60.001 s left: still cached
    await t.auth.getAccessToken();
    expect(t.calls).toHaveLength(0);

    t.clock.advance(1); // exactly 60 s left: refresh
    t.state.token.json = { access_token: 'AT2', expires_in: 3600 };
    expect(await t.auth.getAccessToken()).toEqual({ token: 'AT2', channelId: CH });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.body.get('grant_type')).toBe('refresh_token');
    expect(t.calls[0]!.body.get('refresh_token')).toBe('RT1');
    expect(t.repo.listGoogleAccounts()[0]!.accessToken).toBe('AT2');
  });

  it('shares one refresh between concurrent callers', async () => {
    const t = setup();
    await t.connect();
    t.calls.length = 0;
    t.clock.advance(3600_000);
    let release!: () => void;
    t.state.refreshDelay = new Promise((r) => (release = r));
    t.state.token.json = { access_token: 'AT2', expires_in: 3600 };
    const all = Promise.all([t.auth.getAccessToken(), t.auth.getAccessToken(), t.auth.getAccessToken(CH)]);
    await Promise.resolve();
    release();
    const res = await all;
    expect(res.map((r) => r.token)).toEqual(['AT2', 'AT2', 'AT2']);
    expect(t.calls).toHaveLength(1);
  });

  it('invalid_grant flags needs_reauth, notifies, and throws auth_required; capabilities drop', async () => {
    const t = setup();
    await t.connect();
    t.onChange.mockClear();
    t.clock.advance(3600_000);
    t.state.token = { ok: false, status: 400, json: { error: 'invalid_grant' } };
    await expect(t.auth.getAccessToken()).rejects.toMatchObject({ code: 'auth_required', status: 401 });
    expect(t.repo.listGoogleAccounts()[0]).toMatchObject({ needsReauth: true, lastError: 'invalid_grant' });
    expect(t.onChange).toHaveBeenCalledTimes(1);
    expect(t.auth.canPost()).toBe(false);
    expect(t.auth.pickAccount(CH)).toBeNull();
    // Subsequent calls fail fast without hitting Google.
    t.calls.length = 0;
    await expect(t.auth.getAccessToken()).rejects.toBeInstanceOf(PostError);
    expect(t.calls).toHaveLength(0);
  });

  it('treats a network failure or 5xx as retryable, not as a revoked sign-in', async () => {
    const t = setup();
    await t.connect();
    t.clock.advance(3600_000);
    t.state.token = { ok: false, status: 503, json: {} };
    await expect(t.auth.getAccessToken()).rejects.toMatchObject({ code: 'post_failed', retryable: true });
    expect(t.repo.listGoogleAccounts()[0]!.needsReauth).toBe(false);
  });

  it('throws auth_required with no accounts', async () => {
    const t = setup();
    await expect(t.auth.getAccessToken()).rejects.toMatchObject({ code: 'auth_required' });
  });
});

describe('pickAccount / setDefault', () => {
  it('prefers the account matching the video channel, else the default', async () => {
    const t = setup();
    await t.connect();
    t.repo.upsertGoogleAccount({ ...t.repo.listGoogleAccounts()[0]!, channelId: CH2, isDefault: false });
    expect(t.auth.pickAccount(CH2)!.channelId).toBe(CH2);
    expect(t.auth.pickAccount('UCother')!.channelId).toBe(CH);
    expect(t.auth.pickAccount(null)!.channelId).toBe(CH);
    t.auth.setDefault(CH2);
    expect(t.auth.pickAccount(null)!.channelId).toBe(CH2);
    expect(t.auth.status().accounts.find((a) => a.channelId === CH2)!.isDefault).toBe(true);
  });
});

describe('disconnect', () => {
  it('revokes the refresh token, deletes the row, keeps own-channel registration, and notifies', async () => {
    const t = setup();
    await t.connect();
    t.onChange.mockClear();
    await t.auth.disconnect(CH);
    const revoke = t.calls.find((c) => c.url.startsWith(REVOKE_URL))!;
    expect(revoke.url).toContain('token=RT1');
    expect(t.repo.listGoogleAccounts()).toEqual([]);
    expect(t.repo.getSettings().ownChannelIds).toEqual([CH]);
    expect(t.onChange).toHaveBeenCalledTimes(1);
  });

  it('still deletes when the revoke call fails', async () => {
    const t = setup();
    await t.connect();
    t.state.revokeFails = true;
    await t.auth.disconnect();
    expect(t.repo.listGoogleAccounts()).toEqual([]);
  });
});

describe('status', () => {
  it('reports client + accounts and never leaks tokens', async () => {
    const t = setup();
    await t.connect();
    const s = t.auth.status();
    expect(s).toMatchObject({ clientConfigured: true, clientSource: 'settings', redirectUri: REDIRECT });
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/RT1|AT1|sek/);
    expect(setup({ client: null }).auth.status()).toMatchObject({ clientConfigured: false, clientSource: null });
  });
});

describe('resolveGoogleClient', () => {
  const cfg = (o: Partial<Config> = {}) => ({
    envGoogleClientId: null,
    envGoogleClientSecret: null,
    ...o,
  });
  const ID = 'abc.apps.googleusercontent.com';
  let repo: Repo;
  beforeEach(() => {
    repo = createRepo(openDb(':memory:'));
  });

  it('is null when nothing is configured', () => {
    expect(resolveGoogleClient(cfg(), repo)).toBeNull();
  });

  it('prefers env over settings, and has nowhere else to look', () => {
    repo.updateSettings({ googleClient: { clientId: 'db.apps.googleusercontent.com', clientSecret: 'ds' } });
    const env = { envGoogleClientId: 'env.apps.googleusercontent.com', envGoogleClientSecret: 'es' };
    expect(resolveGoogleClient(cfg(env), repo)).toEqual({
      clientId: env.envGoogleClientId,
      clientSecret: 'es',
      source: 'env',
    });
    expect(resolveGoogleClient(cfg(), repo)).toMatchObject({
      clientSecret: 'ds',
      source: 'settings',
    });
    repo.updateSettings({ googleClient: null });
    expect(resolveGoogleClient(cfg(), repo)).toBeNull();
  });

  it('ignores a half-set env pair', () => {
    expect(resolveGoogleClient(cfg({ envGoogleClientId: ID }), repo)).toBeNull();
  });
});
