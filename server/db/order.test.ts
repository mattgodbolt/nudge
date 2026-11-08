import { beforeEach, describe, expect, it } from 'vitest';
import type { GithubItemUpsert, Repo } from '../contracts.js';
import { makeClock } from '../sync/test-helpers.js';
import { githubItemId } from './feeds.js';
import { openDb } from './db.js';
import { createRepo } from './repo.js';

const clock = makeClock(new Date('2026-11-08T12:00:00.000Z'));
let repo: Repo;
let feedId: number;

const pr = (n: number, createdAt: string): GithubItemUpsert => ({
  id: githubItemId('org', 'app', n),
  kind: 'pr',
  repo: 'org/app',
  number: n,
  title: `PR ${n}`,
  author: 'carol',
  authorAvatarUrl: null,
  authorType: 'User',
  association: 'CONTRIBUTOR',
  bodyPlain: '',
  url: `https://github.com/org/app/pull/${n}`,
  createdAt,
  updatedAt: createdAt,
  sourceState: 'open',
  draft: false,
  comments: 0,
  labels: [],
});

/** Page through a whole list `size` at a time, as the web app does, and return the titles in order. */
function walk(order: 'newest' | 'oldest' | 'arrived' | 'source', size: number): string[] {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = repo.listInbox({ view: 'inbox', order, limit: size, cursor });
    out.push(...page.items.map((i) => i.item.title ?? ''));
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error('paging did not finish');
}

beforeEach(() => {
  repo = createRepo(openDb(':memory:'), clock.now);
  feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' }).id;
  // Arrival order differs from age: PR 1 is the oldest PR but arrives last; the todo arrives in between.
  repo.upsertGithubItems(feedId, [pr(2, '2026-11-02T00:00:00.000Z')]);
  clock.advance(60_000);
  repo.upsertGithubItems(feedId, [pr(3, '2026-11-03T00:00:00.000Z')]);
  clock.advance(60_000);
  repo.addTodo({ title: 'Todo', notes: '', raw: 'Todo', dueAt: null });
  clock.advance(60_000);
  repo.upsertGithubItems(feedId, [pr(1, '2026-11-01T00:00:00.000Z')]);
});

describe('inbox order', () => {
  it('newest (the default) is latest activity first', () => {
    expect(walk('newest', 100)).toEqual(['Todo', 'PR 3', 'PR 2', 'PR 1']);
    expect(repo.listInbox({ view: 'inbox' }).items.map((i) => i.item.title)).toEqual(['Todo', 'PR 3', 'PR 2', 'PR 1']);
  });
  it('oldest is the exact reverse', () => {
    expect(walk('oldest', 100)).toEqual(['PR 1', 'PR 2', 'PR 3', 'Todo']);
  });
  it('arrived puts what landed in Nudge most recently first, whatever its age', () => {
    expect(walk('arrived', 100)).toEqual(['PR 1', 'Todo', 'PR 3', 'PR 2']);
  });
  it('source groups Todos, then GitHub, then YouTube, newest first within each', () => {
    expect(walk('source', 100)).toEqual(['Todo', 'PR 3', 'PR 2', 'PR 1']);
  });
  it.each(['newest', 'oldest', 'arrived', 'source'] as const)('%s pages without skipping or repeating', (order) => {
    const whole = walk(order, 100);
    for (const size of [1, 2, 3]) expect(walk(order, size)).toEqual(whole);
  });
  it('ignores a cursor from a different order instead of misreading it', () => {
    const cursor = repo.listInbox({ view: 'inbox', order: 'newest', limit: 1 }).nextCursor!;
    expect(repo.listInbox({ view: 'inbox', order: 'source', cursor }).items).toHaveLength(4);
  });
});
