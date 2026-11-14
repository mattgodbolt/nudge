import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { GithubClient, GithubItemUpsert, Repo, SyncEngine } from '../contracts.js';
import { openDb, type Db } from '../db/db.js';
import { githubItemId } from '../db/feeds.js';
import { createRepo } from '../db/repo.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeEnv } from '../sync/test-helpers.js';
import { MAX_SNOOZE_LOOKUPS } from './snoozeContext.js';

const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let latest: GithubClient['latestCommenter'];
let calls: { repo: string; number: number; token: string | null }[];

const id = (n: number) => githubItemId('org', 'app', n);
const until = () => new Date(Date.now() + 2 * 3_600_000).toISOString();
const snooze = (ids: string[], u: string | null = until()) =>
  app.inject({ method: 'POST', url: '/api/snooze', headers: H, payload: { commentIds: ids, until: u } as never });
let db: Db;
let repo: Repo;
const metaOf = (itemId: string) =>
  JSON.parse(
    (
      db.prepare("SELECT meta FROM item_events WHERE item_id = ? AND kind = 'snooze' ORDER BY id").get(itemId) as {
        meta: string;
      }
    ).meta,
  ) as Record<string, unknown>;

const up = (n: number, over: Partial<GithubItemUpsert> = {}): GithubItemUpsert => ({
  id: id(n),
  kind: 'pr',
  repo: 'org/app',
  number: n,
  title: `Change ${n}`,
  author: 'carol',
  authorAvatarUrl: null,
  authorType: 'User',
  association: 'CONTRIBUTOR',
  bodyPlain: '',
  url: `https://github.com/org/app/pull/${n}`,
  createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  updatedAt: new Date().toISOString(),
  sourceState: 'open',
  draft: false,
  comments: 2,
  labels: [],
  ...over,
});

beforeEach(() => {
  env = makeEnv({});
  db = openDb(':memory:');
  repo = createRepo(db);
  calls = [];
  latest = async (repo, number, _c, token) => {
    calls.push({ repo, number, token });
    return 'Me';
  };
  const feed = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' });
  repo.upsertGithubItems(feed.id, [up(1), up(2, { comments: 0, kind: 'issue', draft: true })]);
  repo.triage([id(1), id(2)], 'inbox'); // older than the feed's baseline, so they arrived archived
  repo.updateSettings({ github: { token: 'tok', myAccounts: ['me'] } });
  app = buildApp({
    repo,
    engine: { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine,
    bus: env.bus,
    quota: env.quota,
    poster: createHandoffPoster(repo),
    auth: fakeGoogleAuth(),
    addSource: async () => {
      throw new Error('unused');
    },
    testKey: async () => ({ ok: true, message: '' }),
    onSettingsChanged: () => {},
    resolveApiKey: () => ({ key: 'k', source: 'env' }),
    demo: false,
    githubClient: { latestCommenter: (...a) => latest(...a) } as GithubClient,
  });
});
afterEach(() => app.close());

describe('snooze context for GitHub items', () => {
  it('answers without waiting for GitHub, then adds the latest commenter to the event', async () => {
    let release!: (v: string) => void;
    latest = (repo, number, _c, token) => {
      calls.push({ repo, number, token });
      return new Promise((r) => (release = r));
    };
    const res = await snooze([id(1)]);
    expect(res.statusCode).toBe(200);
    expect(res.json().changes).toHaveLength(1);
    expect(metaOf(id(1))).toEqual({ actionId: res.json().actionId }); // lookup still pending
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release('Me');
    await vi.waitFor(() => expect(metaOf(id(1)).lastCommenter).toBe('Me'));
    expect(metaOf(id(1))).toMatchObject({
      actionId: res.json().actionId,
      lastCommenterIsMe: true,
      comments: 2,
      ageDays: 3,
      itemKind: 'pr',
      draft: false,
    });
    expect(calls).toEqual([{ repo: 'org/app', number: 1, token: 'tok' }]);
  });

  it('records someone else as the latest commenter', async () => {
    latest = async () => 'dave';
    await snooze([id(1)]);
    await vi.waitFor(() => expect(metaOf(id(1)).lastCommenter).toBe('dave'));
    expect(metaOf(id(1)).lastCommenterIsMe).toBe(false);
  });

  it('skips the GitHub call when there are no comments', async () => {
    await snooze([id(2)]);
    await vi.waitFor(() => expect(metaOf(id(2)).itemKind).toBe('issue'));
    expect(metaOf(id(2))).toMatchObject({ lastCommenter: null, lastCommenterIsMe: false, comments: 0, draft: true });
    expect(calls).toEqual([]);
  });

  it('leaves the event intact when GitHub fails, and still answers 200', async () => {
    latest = async () => {
      throw new Error('boom');
    };
    const res = await snooze([id(1)]);
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(metaOf(id(1))).toEqual({ actionId: res.json().actionId });
  });

  it('does nothing on unsnooze or for other providers', async () => {
    await snooze([id(1)], null);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it('caps lookups per request', async () => {
    const feed = repo.listFeeds()[0]!;
    const many = Array.from({ length: MAX_SNOOZE_LOOKUPS + 5 }, (_, i) => up(100 + i));
    repo.upsertGithubItems(feed.id, many);
    repo.triage(
      many.map((m) => m.id),
      'inbox',
    );
    await snooze(many.map((m) => m.id));
    await vi.waitFor(() => expect(calls).toHaveLength(MAX_SNOOZE_LOOKUPS));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(MAX_SNOOZE_LOOKUPS);
  });
});
