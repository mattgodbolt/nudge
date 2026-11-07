import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { GatewayError, type SyncEngine, type YtComment } from '../contracts.js';
import { createHandoffPoster, createReplyPoster } from '../reply/poster.js';
import { account, fakeGateway, fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeEnv } from '../sync/test-helpers.js';
import type { ServerEvent } from '../../shared/types.js';

// Real repo + real poster + scripted gateway: the whole POST /reply and /delete path, plus secret hygiene.
const H = { 'x-youtubey': '1', host: '127.0.0.1:4517' };
const ME = 'UC' + 'm'.repeat(22);
const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const SECRET = 'GOCSPX-super-secret-value';

let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let events: ServerEvent[];
let gw: ReturnType<typeof fakeGateway>;
let auth: ReturnType<typeof fakeGoogleAuth>;
let fail: GatewayError | null;

const yt = (id: string, o: Partial<YtComment> = {}): YtComment => ({
  id,
  parentId: null,
  videoId: 'vid1',
  authorName: id,
  authorChannelId: 'UCother',
  authorAvatarUrl: null,
  textHtml: id,
  likeCount: 0,
  publishedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...o,
});

beforeEach(() => {
  env = makeEnv({ settings: { ownChannelIds: [ME], googleClient: { clientId: CLIENT_ID, clientSecret: SECRET } } });
  env.repo.upsertThread({
    id: 't1',
    videoId: 'vid1',
    channelId: 'UCchan',
    canReply: true,
    topComment: yt('t1'),
    totalReplyCount: 0,
    replies: [],
  });
  auth = fakeGoogleAuth([account(ME, { isDefault: true })]);
  fail = null;
  gw = fakeGateway({
    insertReply: async (_t, p) => {
      if (fail) throw fail;
      return yt('mine1', {
        parentId: p.parentId,
        authorChannelId: ME,
        textHtml: p.text,
        publishedAt: new Date().toISOString(),
      });
    },
    deleteComment: async () => {},
  });
  const poster = createReplyPoster({
    repo: env.repo,
    auth,
    quota: env.quota,
    gateway: gw,
    handoff: createHandoffPoster(env.repo),
  });
  events = [];
  env.bus.subscribe((e) => events.push(e));
  app = buildApp({
    repo: env.repo,
    engine: { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine,
    bus: env.bus,
    quota: env.quota,
    poster,
    auth,
    addSource: async () => {
      throw new Error('unused');
    },
    testKey: async () => ({ ok: true, message: '' }),
    onSettingsChanged: () => {},
    resolveApiKey: () => ({ key: 'AIza-the-api-key-1234', source: 'env' }),
    demo: false,
  });
});
afterEach(() => app.close());

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: H, payload: payload as never });
const put = (payload: unknown) =>
  app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: payload as never });

describe('POST /api/comments/:id/reply (api mode)', () => {
  it('returns the posted comment and emits inbox.changed with the new id', async () => {
    const res = await post('/api/comments/t1/reply', { body: 'hello' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'posted', comment: { id: 'mine1', isOwn: true } });
    const ev = events.find((e) => e.type === 'inbox.changed');
    expect(ev).toMatchObject({ type: 'inbox.changed', addedIds: ['mine1'] });
    expect((ev as { changedIds: string[] }).changedIds).toContain('t1');
  });

  it('flags the posted reply postedByApp (drives the Delete reply button) but not the target', async () => {
    await post('/api/comments/t1/reply', { body: 'hello' });
    expect(env.repo.getComment('mine1')?.postedByApp).toBe(true);
    expect(env.repo.getComment('t1')?.postedByApp).toBe(false);
    const thread = env.repo.getThread('t1');
    expect(thread?.comments.find((c) => c.id === 'mine1')?.postedByApp).toBe(true);
  });

  it('maps PostError to its HTTP status + code, and announces a capability change on auth_required', async () => {
    fail = new GatewayError('bad token', 401, null);
    const res = await post('/api/comments/t1/reply', { body: 'hello' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'auth_required' });
    expect(events.map((e) => e.type)).toContain('capabilities.changed');
    expect(env.repo.getComment('t1')!.state).toBe('inbox');
  });

  it.each([
    [429, 'rateLimitExceeded', 429, 'rate_limited'],
    [404, 'parentCommentNotFound', 404, 'comment_gone'],
    [400, 'commentTextTooLong', 400, 'text_too_long'],
  ])('%i %s -> HTTP %i %s', async (status, reason, http, code) => {
    fail = new GatewayError('x', status, reason);
    const res = await post('/api/comments/t1/reply', { body: 'hello' });
    expect([res.statusCode, res.json().code]).toEqual([http, code]);
  });
});

describe('POST /api/comments/:id/delete', () => {
  it('deletes an app-posted reply and emits inbox.changed', async () => {
    await post('/api/comments/t1/reply', { body: 'hello' });
    events.length = 0;
    const res = await post('/api/comments/mine1/delete');
    expect(res.statusCode).toBe(204);
    expect(env.repo.getComment('mine1')).toBeNull();
    expect(events.some((e) => e.type === 'inbox.changed')).toBe(true);
  });

  it('refuses other comments (422) and unknown ids (404)', async () => {
    expect((await post('/api/comments/t1/delete')).statusCode).toBe(422);
    expect((await post('/api/comments/nope/delete')).statusCode).toBe(404);
  });
});

describe('PUT /api/settings googleClient', () => {
  const dl = (id = CLIENT_ID) => JSON.stringify({ installed: { client_id: id, client_secret: 'NEWSECRET' } });

  it('accepts pasted downloaded JSON', async () => {
    const res = await put({ googleClient: { json: dl() } });
    expect(res.statusCode).toBe(200);
    expect(env.repo.getSettings().googleClient).toEqual({ clientId: CLIENT_ID, clientSecret: 'NEWSECRET' });
    expect(events.map((e) => e.type)).toContain('capabilities.changed');
  });

  it('accepts explicit fields and null (remove)', async () => {
    expect((await put({ googleClient: { clientId: CLIENT_ID, clientSecret: 'S2' } })).statusCode).toBe(200);
    expect(env.repo.getSettings().googleClient).toEqual({ clientId: CLIENT_ID, clientSecret: 'S2' });
    expect((await put({ googleClient: null })).statusCode).toBe(200);
    expect(env.repo.getSettings().googleClient).toBeNull();
  });

  it.each([
    ['bad id', { clientId: 'abc', clientSecret: 'S' }],
    ['missing secret', { clientId: CLIENT_ID }],
    ['json without a client', { json: '{"foo":1}' }],
    ['not json', { json: 'nope' }],
    ['wrong type', 'str'],
  ])('rejects %s with 400 and keeps the old client', async (_n, googleClient) => {
    const res = await put({ googleClient });
    expect(res.statusCode).toBe(400);
    expect(env.repo.getSettings().googleClient).toMatchObject({ clientSecret: SECRET });
    expect(res.body).not.toContain('NEWSECRET');
  });
});

describe('secrets never reach the browser', () => {
  it('settings, bootstrap and SSE events contain no client secret or tokens', async () => {
    env.repo.upsertGoogleAccount(
      account(ME, { isDefault: true, refreshToken: 'refresh_token_VALUE', accessToken: 'access_token_VALUE' }),
    );
    await put({ googleClient: { clientId: CLIENT_ID, clientSecret: SECRET } });
    for (const url of ['/api/settings', '/api/bootstrap']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: H.host } });
      expect(res.statusCode).toBe(200);
      for (const needle of [
        SECRET,
        'clientSecret',
        'refresh_token',
        'access_token',
        'refresh_token_VALUE',
        'access_token_VALUE',
      ]) {
        expect(res.body, `${url} leaks ${needle}`).not.toContain(needle);
      }
    }
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain('_VALUE');
    const s = (await app.inject({ method: 'GET', url: '/api/settings', headers: { host: H.host } })).json();
    expect(s.google.accounts[0]).not.toHaveProperty('refreshToken');
  });
});
