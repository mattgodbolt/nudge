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
let discussion: GithubClient['discussion'];
let discussionToken: string | null | undefined;

const send = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, payload: payload as never });

beforeEach(() => {
  env = makeEnv({});
  polled = [];
  discussionToken = undefined;
  discussion = async () => ({ entries: [], olderCut: false });
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
    githubClient: {
      whoami: (t) => whoami(t),
      discussion: (r, n, k, t) => {
        discussionToken = t;
        return discussion(r, n, k, t);
      },
    } as GithubClient,
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

  it('muting an owner archives all its repositories (undoably) and lists as an owner rule', async () => {
    const { id } = (await send('POST', '/api/feeds', { owner: 'org' })).json();
    env.repo.upsertGithubItems(id, [up(1), up(2, 'dave')]);
    const res = await send('POST', '/api/mutes', { kind: 'owner', value: 'org' });
    const body = res.json();
    expect(body.rule).toMatchObject({ kind: 'owner', value: 'org' });
    expect(body.triage.changes).toHaveLength(2);
    expect(env.repo.counts().inbox).toBe(0);
    expect((await send('GET', '/api/feeds')).json().mutes).toEqual([expect.objectContaining({ kind: 'owner' })]);
    expect((await send('POST', `/api/triage/${body.triage.actionId}/undo`)).statusCode).toBe(200);
    expect((await send('DELETE', `/api/mutes/${body.rule.id}`)).statusCode).toBe(204);
    expect((await send('POST', '/api/mutes', { kind: 'owner', value: 'org/app' })).statusCode).toBe(400);
    expect((await send('POST', '/api/mutes', { kind: 'owner', value: '' })).statusCode).toBe(400);
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
      github: { token: ' ghp_abcdefghijklmnop1234 ', myAccounts: ['mattgodbolt', 'example-bot'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().github).toEqual({
      configured: true,
      last4: '1234',
      myAccounts: ['mattgodbolt', 'example-bot'],
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

describe('discussion', () => {
  const up = (n: number): GithubItemUpsert => ({
    id: githubItemId('org', 'app', n),
    kind: 'pr',
    repo: 'org/app',
    number: n,
    title: `T${n}`,
    author: 'carol',
    authorAvatarUrl: null,
    authorType: 'User',
    association: 'NONE',
    bodyPlain: '',
    url: 'https://github.com/org/app/pull/1',
    createdAt: new Date(Date.now() + 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    sourceState: 'open',
    draft: false,
    comments: 2,
    labels: [],
  });
  const path = (n: number) => `/api/items/${encodeURIComponent(githubItemId('org', 'app', n))}/discussion`;
  const seed = async () => {
    const { id } = (await send('POST', '/api/feeds', { owner: 'org' })).json();
    env.repo.upsertGithubItems(id, [up(1)]);
  };

  it('returns the conversation, fetched with the stored token, without leaking the token', async () => {
    await seed();
    env.repo.updateSettings({ github: { token: 'stored-token', myAccounts: [] } });
    discussion = async () => ({
      entries: [
        {
          id: 'c1',
          kind: 'comment',
          author: 'erin',
          avatarUrl: null,
          authorType: 'User',
          association: 'MEMBER',
          createdAt: '2026-11-01T00:00:00.000Z',
          body: 'hello',
          url: null,
        },
      ],
      olderCut: false,
    });
    const res = await send('GET', path(1));
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toMatchObject({ id: 'c1', body: 'hello' });
    expect(res.json().fetchedAt).toEqual(expect.any(String));
    expect(discussionToken).toBe('stored-token');
    expect(res.body).not.toContain('stored-token');
  });

  it('refuses a foreign Host (the app-wide guard), and 404s unknown or non-GitHub items', async () => {
    await seed();
    const bare = await app.inject({ method: 'GET', url: path(1), headers: { ...H, host: 'evil.example' } });
    expect(bare.statusCode).toBe(403);
    expect((await send('GET', path(99))).statusCode).toBe(404);
    expect((await send('GET', '/api/items/not-an-item/discussion')).statusCode).toBe(404);
  });

  it('answers a GitHub failure with 424 and a plain message, never the token', async () => {
    await seed();
    env.repo.updateSettings({ github: { token: 'stored-token', myAccounts: [] } });
    discussion = async () => {
      throw new GithubError('GitHub rejected the token (expired or revoked?)', 401);
    };
    const res = await send('GET', path(1));
    expect(res.statusCode).toBe(424);
    expect(res.json()).toEqual({
      error: 'GitHub rejected the token (expired or revoked?)',
      code: 'github_unavailable',
    });
    discussion = async () => {
      throw new GithubError('GitHub could not find that conversation', 404);
    };
    // Different comment count so the earlier failure cannot matter; failures are not cached anyway.
    expect((await send('GET', path(1))).json().code).toBe('github_not_found');
  });
});
