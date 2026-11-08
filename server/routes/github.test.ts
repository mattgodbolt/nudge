import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { GithubClient, GithubItemUpsert, GithubPoller, SyncEngine } from '../contracts.js';
import { GithubError } from '../contracts.js';
import { githubItemId } from '../db/feeds.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeEnv } from '../sync/test-helpers.js';

const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let polled: (number | undefined)[];
let whoami: GithubClient['whoami'];

const send = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, payload: payload as never });

beforeEach(() => {
  env = makeEnv({});
  polled = [];
  whoami = async () => ({ login: 'me', scopes: ['notifications'] });
  const github: GithubPoller = {
    start() {},
    stop() {},
    async pollNow(id) {
      polled.push(id);
    },
  };
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
    github,
    githubClient: { whoami: (t) => whoami(t) } as GithubClient,
  });
});
afterEach(() => app.close());

describe('feeds', () => {
  it('adds a feed from a name or a github.com URL, polls it, and refuses duplicates and junk', async () => {
    let res = await send('POST', '/api/feeds', { owner: 'https://github.com/compiler-explorer/' });
    expect(res.statusCode).toBe(201);
    const feed = res.json();
    expect(feed).toMatchObject({ owner: 'compiler-explorer', prs: true, issues: true, importMode: 'none' });
    expect(polled).toEqual([feed.id]);
    expect(env.bus.of('feeds.changed')).toHaveLength(1);

    expect((await send('POST', '/api/feeds', { owner: 'Compiler-Explorer' })).statusCode).toBe(409);
    expect((await send('POST', '/api/feeds', { owner: 'a/b' })).statusCode).toBe(400);
    expect((await send('POST', '/api/feeds', { owner: 'x[bot]' })).statusCode).toBe(400);
    expect((await send('POST', '/api/feeds', { owner: 'y', prs: false, issues: false })).statusCode).toBe(400);
    expect((await send('POST', '/api/feeds', { owner: 'z', importMode: 'sideways' })).statusCode).toBe(400);
  });

  it('lists, edits, polls and removes a feed', async () => {
    const { id } = (await send('POST', '/api/feeds', { owner: 'mattgodbolt', issues: false })).json();
    expect((await send('GET', '/api/feeds')).json().feeds).toHaveLength(1);
    let res = await send('PATCH', `/api/feeds/${id}`, { enabled: false });
    expect(res.json().enabled).toBe(false);
    expect((await send('PATCH', `/api/feeds/${id}`, { prs: false })).statusCode).toBe(400); // would leave nothing
    expect((await send('POST', `/api/feeds/${id}/poll`)).statusCode).toBe(202);
    expect(polled.at(-1)).toBe(id);
    expect((await send('DELETE', `/api/feeds/${id}`)).statusCode).toBe(204);
    expect((await send('DELETE', `/api/feeds/${id}`)).statusCode).toBe(404);
    res = await send('PATCH', '/api/feeds/999', { enabled: true });
    expect(res.statusCode).toBe(404);
  });
});

describe('mutes', () => {
  const up = (n: number, author = 'carol'): GithubItemUpsert => ({
    id: githubItemId('org', 'app', n),
    kind: 'pr',
    repo: 'org/app',
    number: n,
    title: `T${n}`,
    author,
    authorAvatarUrl: null,
    authorType: 'User',
    association: 'NONE',
    bodyPlain: '',
    url: 'https://github.com/org/app/pull/1',
    createdAt: new Date(Date.now() + 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    sourceState: 'open',
    draft: false,
    comments: 0,
    labels: [],
  });

  it('muting archives what is in the inbox as an undoable action, and the rule can be removed', async () => {
    const { id } = (await send('POST', '/api/feeds', { owner: 'org' })).json();
    env.repo.upsertGithubItems(id, [up(1), up(2, 'dave')]);
    const res = await send('POST', '/api/mutes', { kind: 'author', value: 'dave' });
    const body = res.json();
    expect(body.rule).toMatchObject({ kind: 'author', value: 'dave' });
    expect(body.triage.changes).toEqual([{ commentId: githubItemId('org', 'app', 2), from: 'inbox', to: 'archived' }]);
    expect(env.repo.counts().inbox).toBe(1);

    // The existing undo endpoint reverses the archiving.
    expect((await send('POST', `/api/triage/${body.triage.actionId}/undo`)).statusCode).toBe(200);
    expect(env.repo.counts().inbox).toBe(2);

    expect((await send('DELETE', `/api/mutes/${body.rule.id}`)).statusCode).toBe(204);
    expect((await send('GET', '/api/feeds')).json().mutes).toEqual([]);
  });

  it('muting with nothing to archive returns no triage, and validates its input', async () => {
    const res = await send('POST', '/api/mutes', { kind: 'bots' });
    expect(res.json()).toMatchObject({ rule: { kind: 'bots', value: '' }, triage: null });
    expect((await send('POST', '/api/mutes', { kind: 'repo', value: 'nope' })).statusCode).toBe(400);
    expect((await send('POST', '/api/mutes', { kind: 'author', value: 'not a login!' })).statusCode).toBe(400);
    expect((await send('POST', '/api/mutes', { kind: 'item', value: 'abc' })).statusCode).toBe(400);
    expect((await send('POST', '/api/mutes', { kind: 'nonsense', value: 'x' })).statusCode).toBe(400);
    expect((await send('DELETE', '/api/mutes/999')).statusCode).toBe(404);
  });
});

describe('GitHub settings', () => {
  it('stores the token and my accounts, never sends the token back, and polls when the token changes', async () => {
    const res = await send('PUT', '/api/settings', {
      github: { token: ' ghp_abcdefghijklmnop1234 ', myAccounts: ['mattgodbolt', 'mattgodbolt-molty'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().github).toEqual({
      configured: true,
      last4: '1234',
      myAccounts: ['mattgodbolt', 'mattgodbolt-molty'],
    });
    expect(JSON.stringify(res.json())).not.toContain('ghp_abcdefghijklmnop');
    expect(env.repo.getSettings().github.token).toBe('ghp_abcdefghijklmnop1234');
    expect(polled).toEqual([undefined]);

    // Changing only the accounts keeps the token.
    const res2 = await send('PUT', '/api/settings', { github: { myAccounts: ['mattgodbolt'] } });
    expect(res2.json().github).toEqual({ configured: true, last4: '1234', myAccounts: ['mattgodbolt'] });
    // null removes it.
    const res3 = await send('PUT', '/api/settings', { github: { token: null } });
    expect(res3.json().github).toMatchObject({ configured: false, last4: null });
  });

  it('rejects bad input', async () => {
    expect((await send('PUT', '/api/settings', { github: { token: 'has space inside' } })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings', { github: { token: 5 } })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings', { github: { myAccounts: ['ok', 'bad name!'] } })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings', { github: { myAccounts: 'me' } })).statusCode).toBe(400);
  });

  it('"Test" reports the login, warns about a token that can write, and relays errors', async () => {
    env.repo.updateSettings({ github: { token: 'stored-token', myAccounts: [] } });
    expect((await send('POST', '/api/settings/test-github', {})).json()).toMatchObject({
      ok: true,
      login: 'me',
      message: 'Signed in as me',
    });
    whoami = async () => ({ login: 'me', scopes: ['repo', 'workflow'] });
    const risky = (await send('POST', '/api/settings/test-github', { token: 'other' })).json();
    expect(risky.ok).toBe(true);
    expect(risky.message).toMatch(/can do more than read \(repo, workflow\)/);
    whoami = async () => {
      throw new GithubError('GitHub rejected the token (expired or revoked?)', 401);
    };
    expect((await send('POST', '/api/settings/test-github', {})).json()).toEqual({
      ok: false,
      message: 'GitHub rejected the token (expired or revoked?)',
    });
    env.repo.updateSettings({ github: { token: null, myAccounts: [] } });
    expect((await send('POST', '/api/settings/test-github', {})).json()).toEqual({
      ok: false,
      message: 'No token to test',
    });
  });
});

describe('inbox filters', () => {
  it('rejects unknown kind and audience values', async () => {
    expect((await send('GET', '/api/inbox?kind=repo')).statusCode).toBe(400);
    expect((await send('GET', '/api/inbox?audience=everyone')).statusCode).toBe(400);
    expect((await send('GET', '/api/inbox?audience=outside&kind=pr')).statusCode).toBe(200);
  });
});
