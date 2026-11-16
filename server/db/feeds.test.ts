import { beforeEach, describe, expect, it } from 'vitest';
import type { GithubItemUpsert, Repo } from '../contracts.js';
import { githubItemId } from './feeds.js';
import { createRepo } from './repo.js';
import { openDb } from './db.js';

let now = new Date('2026-11-08T12:00:00.000Z');
let repo: Repo;
let feedId: number;

const up = (n: number, over: Partial<GithubItemUpsert> = {}): GithubItemUpsert => ({
  id: githubItemId('org', 'app', n),
  kind: 'pr',
  repo: 'org/app',
  number: n,
  title: `Change ${n}`,
  author: 'carol',
  authorAvatarUrl: null,
  authorType: 'User',
  association: 'CONTRIBUTOR',
  bodyPlain: `Body of ${n}`,
  url: `https://github.com/org/app/pull/${n}`,
  createdAt: '2026-11-08T11:00:00.000Z',
  updatedAt: '2026-11-08T11:00:00.000Z',
  sourceState: 'open',
  draft: false,
  comments: 0,
  labels: [],
  ...over,
});
const state = (id: string) => repo.listInbox({ view: 'all' }).items.find((i) => i.item.id === id)?.comment.state;
const inbox = () => repo.listInbox({ view: 'inbox' }).items.map((i) => i.item.id);

beforeEach(() => {
  now = new Date('2026-11-08T12:00:00.000Z');
  repo = createRepo(openDb(':memory:'), () => now);
  // 'none' = from now on: the baseline is the moment the feed was added.
  feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' }).id;
  now = new Date('2026-11-08T12:00:00.000Z');
});

describe('arrival rules', () => {
  it('puts a new item in the inbox with its provider-neutral card and a stand-in comment', () => {
    // Created before the feed was added would be archived, so make the baseline older for this one.
    repo.updateFeed(feedId, {});
    const r = repo.upsertGithubItems(feedId, [up(1, { createdAt: '2026-11-08T12:30:00.000Z' })]);
    expect(r.added).toEqual([githubItemId('org', 'app', 1)]);
    const [row] = repo.listInbox({ view: 'inbox' }).items;
    expect(row!.item).toMatchObject({
      provider: 'github',
      kind: 'pr',
      title: 'Change 1',
      author: 'carol',
      url: 'https://github.com/org/app/pull/1',
      containerKey: 'org/app',
      containerUrl: 'https://github.com/org/app',
      sourceState: 'open',
      reason: 'new',
      muted: false,
      github: { owner: 'org', repo: 'app', number: 1, association: 'CONTRIBUTOR', authorType: 'User' },
    });
    expect(row!.comment).toMatchObject({
      id: row!.item.id,
      authorName: 'carol',
      state: 'inbox',
      textPlain: 'Body of 1',
    });
    expect(row!.comment.textHtml).toBe('Body of 1');
    expect(repo.counts()).toMatchObject({ inbox: 1, byFeed: { [feedId]: 1 } });
  });

  it('archives items older than the feed baseline, so only what arrives from now on is news', () => {
    repo.upsertGithubItems(feedId, [up(1, { createdAt: '2026-11-01T00:00:00.000Z' })]);
    expect(state(githubItemId('org', 'app', 1))).toBe('archived');
    expect(inbox()).toEqual([]);
  });

  it('files my own items as own, and items already closed as resolved (Done)', () => {
    repo.updateSettings({ github: { token: null, myAccounts: ['Me'] } });
    repo.upsertGithubItems(feedId, [
      up(1, { author: 'me', createdAt: '2026-11-08T12:10:00.000Z' }),
      up(2, { sourceState: 'merged', createdAt: '2026-11-08T12:10:00.000Z' }),
    ]);
    expect(state(githubItemId('org', 'app', 1))).toBeUndefined(); // 'own' never appears in "all"
    expect(state(githubItemId('org', 'app', 2))).toBe('resolved');
    expect(repo.counts().done).toBe(1);
  });

  it('is idempotent: polling the same window twice changes nothing', () => {
    const u = up(1, { createdAt: '2026-11-08T12:10:00.000Z' });
    repo.upsertGithubItems(feedId, [u]);
    repo.triage([u.id], 'done');
    repo.upsertGithubItems(feedId, [u]);
    expect(state(u.id)).toBe('done');
  });
});

describe('closing, reopening and activity', () => {
  const fresh = (n: number, over: Partial<GithubItemUpsert> = {}) =>
    up(n, { createdAt: '2026-11-08T12:10:00.000Z', ...over });

  it('resolves an inbox item when it is closed or merged at GitHub, and brings it back if reopened there', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.upsertGithubItems(feedId, [{ ...u, sourceState: 'merged' }]);
    expect(state(u.id)).toBe('resolved');
    const r = repo.upsertGithubItems(feedId, [{ ...u, sourceState: 'open' }]);
    expect(state(u.id)).toBe('inbox');
    expect(r.reopened).toEqual([u.id]);
    expect(repo.listInbox({ view: 'inbox' }).items[0]!.item.reason).toBe('reopened');
  });

  it('never moves an item the user deliberately put in the inbox', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.triage([u.id], 'done');
    repo.triage([u.id], 'inbox');
    repo.upsertGithubItems(feedId, [{ ...u, sourceState: 'closed' }]);
    expect(state(u.id)).toBe('inbox');
  });

  it('brings a Done item back when someone new comments while it is open', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.triage([u.id], 'done');
    const r = repo.upsertGithubItems(feedId, [{ ...u, comments: 1, lastCommenter: 'carol', lastCommenterIsMe: false }]);
    expect(r.reopened).toEqual([u.id]);
    const row = repo.listInbox({ view: 'inbox' }).items[0]!;
    expect(row.item.reason).toBe('new_activity');
    expect(row.wokeAt).not.toBeNull(); // floats to the top
  });

  it('records who commented and the cut-off for "new" when a Done item comes back', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.triage([u.id], 'done');
    repo.upsertGithubItems(feedId, [{ ...u, comments: 2, lastCommenter: 'dave', lastCommenterIsMe: false }]);
    const g = repo.listInbox({ view: 'inbox' }).items[0]!.item.github!;
    expect(g.lastCommenter).toBe('dave');
    expect(g.activitySince).toEqual(expect.any(String));
    // A later poll without a lookup keeps both while the count is unchanged.
    repo.upsertGithubItems(feedId, [{ ...u, comments: 2 }]);
    expect(repo.listInbox({ view: 'inbox' }).items[0]!.item.github).toMatchObject({
      lastCommenter: 'dave',
      activitySince: g.activitySince,
    });
  });

  it('leaves a Done item alone while who commented is unknown, and keeps the old count so the growth is seen again', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.triage([u.id], 'done');
    // The poller could not look it up (failed, or past its cap): neither "mine" nor "theirs".
    expect(repo.upsertGithubItems(feedId, [{ ...u, comments: 2 }]).reopened).toEqual([]);
    expect(state(u.id)).toBe('done');
    expect(repo.githubItemMeta([u.id]).get(u.id)?.comments).toBe(0);
    // Next poll it is known.
    const r = repo.upsertGithubItems(feedId, [{ ...u, comments: 2, lastCommenter: 'dave', lastCommenterIsMe: false }]);
    expect(r.reopened).toEqual([u.id]);
    expect(repo.listInbox({ view: 'inbox' }).items[0]!.item.github?.lastCommenter).toBe('dave');
  });

  it('takes in new comments on an inbox item without asking who wrote them', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.upsertGithubItems(feedId, [{ ...u, comments: 3 }]);
    expect(repo.githubItemMeta([u.id]).get(u.id)?.comments).toBe(3);
  });

  it('exposes no commenter for an item that is merely new', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [{ ...u, lastCommenter: 'dave' }]);
    expect(repo.listInbox({ view: 'inbox' }).items[0]!.item.github).not.toHaveProperty('lastCommenter');
  });

  it('does not reopen for my own comment, on a closed item, or for the same comment count', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.triage([u.id], 'done');
    repo.upsertGithubItems(feedId, [{ ...u, comments: 1, lastCommenterIsMe: true }]);
    expect(state(u.id)).toBe('done');
    repo.upsertGithubItems(feedId, [{ ...u, comments: 1 }]); // count did not grow past what we stored
    expect(state(u.id)).toBe('done');
    repo.upsertGithubItems(feedId, [{ ...u, comments: 5, sourceState: 'closed' }]);
    expect(state(u.id)).toBe('done');
  });

  it('a muted item resolves but never reopens', () => {
    const u = fresh(1);
    repo.upsertGithubItems(feedId, [u]);
    repo.triage([u.id], 'done');
    repo.addMuteRule('item', u.id);
    repo.upsertGithubItems(feedId, [{ ...u, comments: 3 }]);
    expect(state(u.id)).toBe('done');
  });
});

describe('mute rules', () => {
  const fresh = (n: number, over: Partial<GithubItemUpsert> = {}) =>
    up(n, { createdAt: '2026-11-08T12:10:00.000Z', ...over });

  it('a repo, author or bots rule archives matching items on arrival, still searchable in All', () => {
    repo.addMuteRule('repo', 'org/noisy');
    repo.addMuteRule('author', 'Spammer');
    repo.addMuteRule('bots', '');
    repo.upsertGithubItems(feedId, [
      fresh(1, { repo: 'org/noisy', id: githubItemId('org', 'noisy', 1) }),
      fresh(2, { author: 'spammer' }),
      fresh(3, { author: 'dependabot[bot]', authorType: 'Bot' }),
      fresh(4),
    ]);
    expect(inbox()).toEqual([githubItemId('org', 'app', 4)]);
    const archived = repo.listInbox({ view: 'all', q: 'Change' }).items.filter((i) => i.comment.state === 'archived');
    expect(archived).toHaveLength(3);
    expect(archived.every((i) => i.item.muted && i.item.reason === 'muted')).toBe(true);
  });

  it('a new rule reports what it covers in the inbox, and deleting it stops muting new arrivals', () => {
    repo.upsertGithubItems(feedId, [fresh(1, { author: 'dave' }), fresh(2)]);
    const { rule, affectedIds } = repo.addMuteRule('author', 'dave');
    expect(affectedIds).toEqual([githubItemId('org', 'app', 1)]);
    expect(repo.listMuteRules()).toEqual([expect.objectContaining({ id: rule.id, kind: 'author', value: 'dave' })]);
    expect(repo.deleteMuteRule(rule.id)).toBe(true);
    repo.upsertGithubItems(feedId, [fresh(3, { author: 'dave' })]);
    expect(inbox()).toContain(githubItemId('org', 'app', 3));
  });

  it('an owner rule mutes every repository of that organisation, whatever the case, and nothing else', () => {
    const other = (n: number, owner: string, name: string) =>
      fresh(n, { repo: `${owner}/${name}`, id: githubItemId(owner, name, n) });
    repo.upsertGithubItems(feedId, [
      other(1, 'org', 'app'),
      other(2, 'org', 'tools'),
      other(3, 'org-two', 'app'),
      other(4, 'orgs', 'app'),
    ]);
    const { affectedIds } = repo.addMuteRule('owner', 'ORG');
    // Existing items are covered at once; "org-two" and "orgs" merely start with the same letters.
    expect(affectedIds.sort()).toEqual([githubItemId('org', 'app', 1), githubItemId('org', 'tools', 2)].sort());
    expect(repo.listMuteRules()).toEqual([expect.objectContaining({ kind: 'owner', value: 'ORG' })]);
    // And new arrivals land archived.
    repo.upsertGithubItems(feedId, [other(5, 'org', 'brand-new'), other(6, 'orgs', 'app')]);
    expect(inbox()).toEqual(
      expect.arrayContaining([githubItemId('org-two', 'app', 3), githubItemId('orgs', 'app', 6)]),
    );
    expect(inbox()).not.toContain(githubItemId('org', 'brand-new', 5));
    // Unmuting brings the flag back down for the items it covered.
    const rule = repo.listMuteRules()[0]!;
    expect(repo.deleteMuteRule(rule.id)).toBe(true);
    repo.upsertGithubItems(feedId, [other(7, 'org', 'app')]);
    expect(inbox()).toContain(githubItemId('org', 'app', 7));
  });

  it('existing repo, author and bots rules are unchanged by owner rules', () => {
    repo.addMuteRule('owner', 'elsewhere');
    repo.addMuteRule('author', 'dave');
    repo.upsertGithubItems(feedId, [fresh(1, { author: 'dave' }), fresh(2)]);
    expect(inbox()).toEqual([githubItemId('org', 'app', 2)]);
  });

  it('adding the same rule twice keeps one', () => {
    repo.addMuteRule('repo', 'org/app');
    repo.addMuteRule('repo', 'org/app');
    expect(repo.listMuteRules()).toHaveLength(1);
  });
});

describe('who is me', () => {
  it('moves existing items in and out of the own state when the accounts change', () => {
    const u = up(1, { author: 'robot', createdAt: '2026-11-08T12:10:00.000Z' });
    repo.upsertGithubItems(feedId, [u]);
    expect(inbox()).toEqual([u.id]);
    repo.updateSettings({ github: { token: null, myAccounts: ['robot'] } });
    expect(inbox()).toEqual([]);
    repo.updateSettings({ github: { token: null, myAccounts: [] } });
    expect(inbox()).toEqual([u.id]);
  });
});

describe('filters and counts', () => {
  it('filters by feed, kind and who opened it', () => {
    const t = '2026-11-08T12:10:00.000Z';
    const other = repo.addFeed({ owner: 'other', prs: true, issues: true, importMode: 'none' });
    repo.upsertGithubItems(feedId, [
      up(1, { createdAt: t, association: 'MEMBER' }),
      up(2, { createdAt: t, association: 'FIRST_TIME_CONTRIBUTOR' }),
      up(3, { createdAt: t, association: 'NONE' }),
      up(4, { createdAt: t, association: 'CONTRIBUTOR', kind: 'issue' }),
      up(5, { createdAt: t, author: 'dependabot[bot]', authorType: 'Bot', association: 'NONE' }),
    ]);
    repo.upsertGithubItems(other.id, [up(6, { repo: 'other/x', id: githubItemId('other', 'x', 6), createdAt: t })]);
    const ids = (q: Parameters<Repo['listInbox']>[0]) =>
      repo
        .listInbox(q)
        .items.map((i) => i.item.github?.number)
        .sort();
    expect(ids({ view: 'inbox', feedId })).toEqual([1, 2, 3, 4, 5]);
    expect(ids({ view: 'inbox', feedId: other.id })).toEqual([6]);
    expect(ids({ view: 'inbox', kind: 'issue' })).toEqual([4]);
    expect(ids({ view: 'inbox', audience: 'outside' })).toEqual([2, 3]);
    expect(ids({ view: 'inbox', audience: 'team' })).toEqual([1]);
    expect(ids({ view: 'inbox', audience: 'contributors' })).toEqual([4, 6]);
    expect(ids({ view: 'inbox', audience: 'bots' })).toEqual([5]);
    expect(ids({ view: 'inbox', audience: 'people' })).toEqual([1, 2, 3, 4, 6]);
    expect(ids({ view: 'inbox', videoId: 'org/app' })).toEqual([1, 2, 3, 4, 5]);
    expect(repo.counts().byFeed).toEqual({ [feedId]: 5, [other.id]: 1 });
  });

  it('searches titles and bodies, and triage and snooze work on GitHub items like any other', () => {
    const u = up(1, { createdAt: '2026-11-08T12:10:00.000Z', title: 'Segfault in the parser', bodyPlain: 'crashes' });
    repo.upsertGithubItems(feedId, [u]);
    expect(repo.listInbox({ view: 'inbox', q: 'segfault' }).total).toBe(1);
    expect(repo.listInbox({ view: 'inbox', q: 'crashes' }).total).toBe(1);
    repo.snooze([u.id], '2999-01-01T00:00:00.000Z');
    expect(repo.counts()).toMatchObject({ inbox: 0, snoozed: 1 });
    repo.snooze([u.id], null);
    repo.triage([u.id], 'done');
    expect(repo.counts()).toMatchObject({ inbox: 0, done: 1 });
  });

  it('removing a feed removes its items and search entries', () => {
    const u = up(1, { createdAt: '2026-11-08T12:10:00.000Z' });
    repo.upsertGithubItems(feedId, [u]);
    expect(repo.deleteFeed(feedId)).toBe(true);
    expect(repo.listInbox({ view: 'all' }).total).toBe(0);
    expect(repo.listInbox({ view: 'all', q: 'Change' }).total).toBe(0);
  });
});

describe('repo feeds', () => {
  const inRepo = (name: string, n: number) =>
    up(n, {
      id: githubItemId('org', name, n),
      repo: `org/${name}`,
      createdAt: '2026-11-08T12:10:00.000Z',
    });
  let rawDb: ReturnType<typeof openDb>;
  const feedOf = (id: string): number =>
    (rawDb.prepare('SELECT feed_id FROM items WHERE id = ?').get(id) as { feed_id: number }).feed_id;
  beforeEach(() => {
    rawDb = openDb(':memory:');
    repo = createRepo(rawDb, () => now);
    now = new Date('2026-11-08T12:00:00.000Z');
  });

  it('stores owner/repo in the owner column with kind repo, and may sit beside an owner feed of that owner', () => {
    const r = repo.addFeed({ owner: 'org/app', prs: true, issues: true, importMode: 'all' });
    expect(r).toMatchObject({ owner: 'org/app', kind: 'repo', ownerType: null, importMode: 'all' });
    const o = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' });
    expect(o.kind).toBe('owner');
    expect(repo.listFeeds().map((f) => f.owner)).toEqual(['org/app', 'org']);
    expect(() => repo.addFeed({ owner: 'org/app', prs: true, issues: true, importMode: 'none' })).toThrow(/UNIQUE/);
  });

  it('a repo feed keeps its own items, and removing it removes them', () => {
    const r = repo.addFeed({ owner: 'org/app', prs: true, issues: true, importMode: 'none' });
    repo.upsertGithubItems(r.id, [inRepo('app', 1)]);
    expect(feedOf(githubItemId('org', 'app', 1))).toBe(r.id);
    expect(repo.deleteFeed(r.id)).toBe(true);
    expect(repo.listInbox({ view: 'all' }).total).toBe(0);
  });

  it('adding the owner feed later takes over the repo feed items, so removing the repo feed keeps them', () => {
    const r = repo.addFeed({ owner: 'org/app', prs: true, issues: true, importMode: 'none' });
    repo.upsertGithubItems(r.id, [inRepo('app', 1), inRepo('other', 2)]);
    const o = repo.addFeed({ owner: 'ORG', prs: true, issues: true, importMode: 'none' });
    expect(feedOf(githubItemId('org', 'app', 1))).toBe(o.id);
    expect(feedOf(githubItemId('org', 'other', 2))).toBe(o.id);
    expect(repo.deleteFeed(r.id)).toBe(true);
    expect(repo.listInbox({ view: 'all' }).total).toBe(2);
    expect(repo.getFeed(o.id)!.itemCount).toBe(2);
  });

  it('a repo feed polled while an owner feed exists files new items under the owner feed, and moves old ones', () => {
    const r = repo.addFeed({ owner: 'org/app', prs: true, issues: true, importMode: 'none' });
    const o = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' });
    repo.upsertGithubItems(r.id, [inRepo('app', 3)]);
    expect(feedOf(githubItemId('org', 'app', 3))).toBe(o.id);
    repo.deleteFeed(r.id);
    expect(repo.listInbox({ view: 'all' }).total).toBe(1);
  });

  it('removing the owner feed hands a repo feed its repository items, and drops the rest', () => {
    const o = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' });
    const r = repo.addFeed({ owner: 'org/app', prs: true, issues: true, importMode: 'none' });
    repo.upsertGithubItems(o.id, [inRepo('app', 1), inRepo('other', 2)]);
    repo.deleteFeed(o.id);
    expect(feedOf(githubItemId('org', 'app', 1))).toBe(r.id);
    expect(repo.listInbox({ view: 'all' }).items.map((i) => i.item.id)).toEqual([githubItemId('org', 'app', 1)]);
  });
});
