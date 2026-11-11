import { beforeEach, describe, expect, it } from 'vitest';
import { GithubError, type GithubClient, type GithubItemUpsert, type Repo } from '../contracts.js';
import { githubItemId } from '../db/feeds.js';
import { createGithubPoller } from './github.js';
import { createRepo } from '../db/repo.js';
import { openDb } from '../db/db.js';
import { makeBus, makeClock } from './test-helpers.js';

let clock = makeClock(new Date('2026-11-08T12:00:00.000Z'));
const T = (min: number) => new Date(clock.now().getTime() + min * 60_000).toISOString();

const item = (n: number, over: Partial<GithubItemUpsert> = {}): GithubItemUpsert => ({
  id: githubItemId('org', 'app', n),
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
  createdAt: T(10),
  updatedAt: T(10),
  sourceState: 'open',
  draft: false,
  comments: 0,
  labels: [],
  ...over,
});

interface Script {
  pages: GithubItemUpsert[][];
  queries: string[];
  commenter: string | null;
  fail: unknown;
  ownerType: 'org' | 'user' | null;
}
function fakeClient(s: Script): GithubClient {
  return {
    async whoami() {
      return { login: 'me', scopes: [] };
    },
    async ownerType() {
      return s.ownerType;
    },
    async search(q, page) {
      s.queries.push(`${page}:${q}`);
      // Like the real API: a search must be for pull requests or for issues, never "both".
      if (!/\bis:(pr|issue)\b/.test(q)) {
        throw new GithubError("GitHub said 422: Query must include 'is:issue' or 'is:pull-request'", 422);
      }
      if (s.fail) throw s.fail;
      const kind = /\bis:pr\b/.test(q) ? 'pr' : 'issue';
      const items = (s.pages[page - 1] ?? []).filter((i) => i.kind === kind);
      return { items, total: 0, rate: { limit: 30, remaining: 28, resetAt: T(1) } };
    },
    async latestCommenter() {
      return s.commenter;
    },
  };
}

let repo: Repo;
let bus: ReturnType<typeof makeBus>;
let script: Script;
let feedId: number;
const poller = (over = {}) =>
  createGithubPoller({ repo, bus, client: fakeClient(script), clock: clock.now, intervalMs: 300_000, ...over });

beforeEach(() => {
  script = { pages: [], queries: [], commenter: null, fail: null, ownerType: 'org' };
  clock = makeClock(new Date('2026-11-08T12:00:00.000Z'));
  repo = createRepo(openDb(':memory:'), clock.now);
  bus = makeBus();
  feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' }).id;
});

describe('GitHub poller', () => {
  it('searches the owner since the baseline, files arrivals, announces them, and schedules the next poll', async () => {
    script.pages = [[item(1), item(2, { kind: 'issue' })]];
    await poller().pollNow();
    // Pull requests and issues are separate queries (GitHub rejects a search that is neither is:pr nor is:issue).
    const since = clock
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    expect(script.queries).toEqual([`1:org:org is:pr updated:>=${since}`, `1:org:org is:issue updated:>=${since}`]);
    expect(repo.getFeedRow(feedId)!.lastError).toBeNull();
    expect(repo.listInbox({ view: 'inbox' }).total).toBe(2);
    const ev = bus.of('inbox.changed').at(-1)!;
    expect(ev.addedIds).toHaveLength(2);
    expect(ev.reason).toBe('sync');
    const f = repo.getFeed(feedId)!;
    expect(f).toMatchObject({ ownerType: 'org', lastError: null, rate: { limit: 30, remaining: 28 } });
    expect(f.nextPollAt).toBe(T(5));
    expect(bus.of('feeds.changed')).toHaveLength(1);
  });

  it('uses the cursor (with an overlap for search lag) on later polls, and is:pr / is:issue when only one is wanted', async () => {
    repo.updateFeed(feedId, { issues: false });
    await poller().pollNow();
    clock.advance(10 * 60_000);
    await poller().pollNow();
    expect(script.queries).toHaveLength(2); // one is:pr query per poll, and no is:issue one
    expect(script.queries.every((q) => / is:pr /.test(q) && !/is:issue/.test(q))).toBe(true);
    const second = script.queries[1]!;
    // Cursor = first poll time (12:00); the window starts 15 minutes earlier.
    expect(second).toContain('updated:>=2026-11-08T11:45:00Z');
  });

  it('first import of "everything" asks for open items only', async () => {
    repo.deleteFeed(feedId);
    feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' }).id;
    await poller().pollNow();
    expect(script.queries[0]).toMatch(/is:pr updated:>=1970-01-01T00:00:00Z is:open$/);
    expect(script.queries[1]).toMatch(/is:issue updated:>=1970-01-01T00:00:00Z is:open$/);
  });

  it('only polls feeds that are due, and skips disabled ones', async () => {
    const p = poller();
    await p.pollNow();
    script.queries.length = 0;
    await p.tick(); // not due for another five minutes
    expect(script.queries).toEqual([]);
    clock.advance(6 * 60_000);
    await p.tick();
    expect(script.queries).toHaveLength(2); // is:pr and is:issue
    repo.updateFeed(feedId, { enabled: false });
    clock.advance(10 * 60_000);
    script.queries.length = 0;
    await p.tick();
    await p.pollNow();
    expect(script.queries).toEqual([]);
  });

  it('keeps going when a window has more than the page cap, continuing from the newest item seen', async () => {
    const full = (start: number) => Array.from({ length: 100 }, (_, i) => item(start + i, { updatedAt: T(start + i) }));
    script.pages = [full(1), full(101)];
    await poller({ maxPages: 2 }).pollNow();
    expect(repo.listInbox({ view: 'all' }).total).toBe(200);
    const f = repo.getFeedRow(feedId)!;
    expect(f.cursor).toBe(T(200));
    expect(f.nextPollAt).toBe(clock.now().toISOString()); // due again immediately
  });

  it('merges pull requests and issues, and resumes from the truncated kind when only one hits the page cap', async () => {
    const prs = Array.from({ length: 100 }, (_, i) => item(1 + i, { updatedAt: T(1 + i) }));
    script.pages = [[...prs, item(500, { kind: 'issue', updatedAt: T(50) })]];
    // Page 1 holds a full page of PRs and one issue: with one page allowed, the PR query is truncated, the issue one not.
    await poller({ maxPages: 1 }).pollNow();
    expect(repo.listInbox({ view: 'all' }).total).toBe(101);
    expect(repo.listInbox({ view: 'all', kind: 'issue' }).total).toBe(1);
    expect(repo.getFeedRow(feedId)!.cursor).toBe(T(100)); // the truncated kind's newest item, not the issue's
  });

  it('asks who commented last only for Done items that gained comments, and respects that answer', async () => {
    script.pages = [[item(1)]];
    const p = poller();
    await p.pollNow();
    repo.triage([githubItemId('org', 'app', 1)], 'done');
    repo.updateSettings({ github: { token: null, myAccounts: ['Me-Bot'] } });

    script.pages = [[item(1, { comments: 2 })]];
    script.commenter = 'me-bot';
    await p.pollNow();
    expect(repo.listInbox({ view: 'inbox' }).total).toBe(0); // my own agent's comment is not a nudge

    script.pages = [[item(1, { comments: 3 })]];
    script.commenter = 'someone-else';
    await p.pollNow();
    expect(repo.listInbox({ view: 'inbox' }).total).toBe(1);
    expect(bus.of('inbox.changed').at(-1)!.addedIds).toEqual([githubItemId('org', 'app', 1)]);
    // The lookup the poller already makes names the commenter for the chip, at no extra cost.
    expect(repo.listInbox({ view: 'inbox' }).items[0]!.item.github?.lastCommenter).toBe('someone-else');
  });

  it('records a failure, backs off, and clears the error on the next success', async () => {
    script.fail = new GithubError('GitHub is unavailable (502)', 502);
    const p = poller();
    await p.pollNow();
    let f = repo.getFeedRow(feedId)!;
    expect(f).toMatchObject({ errorCount: 1, lastError: 'GitHub is unavailable (502)' });
    expect(f.nextPollAt).toBe(T(1));
    await p.pollNow();
    f = repo.getFeedRow(feedId)!;
    expect(f.errorCount).toBe(2);
    expect(f.nextPollAt).toBe(T(2));

    script.fail = null;
    await p.pollNow();
    f = repo.getFeedRow(feedId)!;
    expect(f).toMatchObject({ errorCount: 0, lastError: null, backoffUntil: null });
  });

  it('waits out a rate limit until GitHub says it resets, and does not hammer a feed in backoff', async () => {
    script.fail = new GithubError('rate limited', 403, T(20));
    const p = poller();
    await p.pollNow();
    expect(repo.getFeedRow(feedId)!.nextPollAt).toBe(T(20));
    script.queries.length = 0;
    clock.advance(10 * 60_000);
    await p.tick();
    expect(script.queries).toEqual([]);
  });

  it('reports an unknown owner as the feed error', async () => {
    script.ownerType = null;
    await poller().pollNow();
    expect(repo.getFeedRow(feedId)!.lastError).toMatch(/no user or organisation called "org"/);
  });
});
