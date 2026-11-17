import { describe, expect, it } from 'vitest';
import { GithubError } from '../../contracts.js';
import {
  cleanBody,
  createGithubClient,
  lastPageOf,
  mapInlineComment,
  mapIssueComment,
  mapReview,
  mapSearchItem,
} from './client.js';

const issue = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Fix it',
  user: { login: 'carol', avatar_url: 'https://a/b.png', type: 'User' },
  author_association: 'FIRST_TIME_CONTRIBUTOR',
  body: 'Hello <!-- template comment --> world',
  html_url: 'https://github.com/org/app/pull/7',
  created_at: '2026-11-08T10:00:00Z',
  updated_at: '2026-11-08T11:00:00Z',
  state: 'open',
  comments: 2,
  labels: [{ name: 'bug' }, { name: 'help wanted' }],
  repository_url: 'https://api.github.com/repos/org/app',
  pull_request: { merged_at: null },
  draft: true,
  ...over,
});

describe('mapSearchItem', () => {
  it('maps a pull request', () => {
    expect(mapSearchItem(issue())).toEqual({
      id: 'gh:org/app#7',
      kind: 'pr',
      repo: 'org/app',
      number: 7,
      title: 'Fix it',
      author: 'carol',
      authorAvatarUrl: 'https://a/b.png',
      authorType: 'User',
      association: 'FIRST_TIME_CONTRIBUTOR',
      bodyPlain: 'Hello  world',
      url: 'https://github.com/org/app/pull/7',
      createdAt: '2026-11-08T10:00:00.000Z',
      updatedAt: '2026-11-08T11:00:00.000Z',
      sourceState: 'open',
      draft: true,
      comments: 2,
      labels: ['bug', 'help wanted'],
    });
  });

  it('tells merged from closed, and issues from pull requests', () => {
    expect(
      mapSearchItem(issue({ state: 'closed', pull_request: { merged_at: '2026-11-08T12:00:00Z' } }))?.sourceState,
    ).toBe('merged');
    expect(mapSearchItem(issue({ state: 'closed', pull_request: { merged_at: null } }))?.sourceState).toBe('closed');
    const i = mapSearchItem(issue({ pull_request: undefined }));
    expect(i?.kind).toBe('issue');
  });

  it('survives a deleted author, an unknown association and a bad record', () => {
    const m = mapSearchItem(issue({ user: null, author_association: 'WEIRD' }));
    expect(m).toMatchObject({ author: 'ghost', authorType: null, association: null });
    expect(mapSearchItem(issue({ repository_url: 'nonsense' }))).toBeNull();
    expect(mapSearchItem(issue({ number: 'x' }))).toBeNull();
  });

  it('caps very long bodies', () => {
    expect(cleanBody('x'.repeat(5000)).length).toBe(4001);
    expect(cleanBody(null)).toBe('');
  });

  it('strips HTML comments the way the old regex did', () => {
    expect(cleanBody('a<!-- x -->b<!--\ny\n-->c')).toBe('abc');
    expect(cleanBody('a<!-->b-->c')).toBe('ac');
    expect(cleanBody('a<!-- open <!-- nested -->b-->')).toBe('ab-->');
    expect(cleanBody('a<!-- x -->b<!-- never closed')).toBe('ab<!-- never closed');
    expect(cleanBody('  <!-- only -->\r\n hi \r\n')).toBe('hi');
  });

  it('cleans a hostile body of unclosed comment openers in linear time', () => {
    const body = '<!--'.repeat(64 * 1024);
    const t = performance.now();
    const out = cleanBody(body);
    expect(performance.now() - t).toBeLessThan(50);
    expect(out.length).toBe(4001);
  });
});

function client(res: (url: string) => Response) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const c = createGithubClient({
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return res(url);
    }) as unknown as typeof fetch,
  });
  return { c, seen };
}
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('the client', () => {
  it('searches oldest-update-first, sends the token, and reports the rate limit', async () => {
    const { c, seen } = client(() =>
      json(
        { total_count: 1, items: [issue()] },
        { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '29', 'x-ratelimit-reset': '1794160000' },
      ),
    );
    const page = await c.search('org:x updated:>=2026-11-08T00:00:00Z', 2, 'tok');
    const u = new URL(seen[0]!.url);
    expect(u.origin + u.pathname).toBe('https://api.github.com/search/issues');
    expect(u.searchParams.get('sort')).toBe('updated');
    expect(u.searchParams.get('order')).toBe('asc');
    expect(u.searchParams.get('page')).toBe('2');
    expect(seen[0]!.headers.Authorization).toBe('Bearer tok');
    expect(page.items).toHaveLength(1);
    expect(page.rate).toEqual({ limit: 30, remaining: 29, resetAt: new Date(1794160000 * 1000).toISOString() });
  });

  it('works without a token (public repos only) and sends no Authorization header', async () => {
    const { c, seen } = client(() => json({ total_count: 0, items: [] }));
    await c.search('org:x', 1, null);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
  });

  it('turns a rate limit into a retry time, a bad token into a clear error, and an outage into an error', async () => {
    const limited = client(() =>
      json({}, { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794160000' }, 403),
    );
    await expect(limited.c.search('q', 1, null)).rejects.toMatchObject({
      status: 403,
      retryAt: new Date(1794160000 * 1000).toISOString(),
    });
    const retry = client(() => json({}, { 'retry-after': '30' }, 429));
    const err = (await retry.c.search('q', 1, null).catch((e) => e)) as GithubError;
    expect(err.retryAt && Date.parse(err.retryAt) - Date.now()).toBeGreaterThan(20_000);
    await expect(client(() => json({}, {}, 401)).c.search('q', 1, 't')).rejects.toThrow(/rejected the token/);
    await expect(client(() => json({}, {}, 502)).c.search('q', 1, 't')).rejects.toThrow(/unavailable/);
    const refused = client(() => json({ message: 'nope' }, {}, 403));
    const e2 = (await refused.c.search('q', 1, 't').catch((e) => e)) as GithubError;
    expect(e2.retryAt).toBeNull();
  });

  it('knows an organisation from a user, and a missing owner', async () => {
    expect(await client(() => json({ type: 'Organization' })).c.ownerType('example-org', null)).toBe('org');
    expect(await client(() => json({ type: 'User' })).c.ownerType('example-user', null)).toBe('user');
    expect(await client(() => json({}, {}, 404)).c.ownerType('nobody-here', null)).toBeNull();
  });

  it("reports a token's login and scopes (null for fine-grained tokens, which send none)", async () => {
    const classic = client(() => json({ login: 'me' }, { 'x-oauth-scopes': 'notifications, repo' }));
    expect(await classic.c.whoami('t')).toEqual({ login: 'me', scopes: ['notifications', 'repo'] });
    expect((await client(() => json({ login: 'me' })).c.whoami('t')).scopes).toBeNull();
  });

  it('reads the newest comment from the last one-per-page page, and never touches other hosts', async () => {
    const { c, seen } = client(() => json([{ user: { login: 'dave' } }]));
    expect(await c.latestCommenter('org/app', 7, 4, 't')).toBe('dave');
    expect(seen[0]!.url).toBe('https://api.github.com/repos/org/app/issues/7/comments?per_page=1&page=4');
    expect(await c.latestCommenter('org/app', 7, 0, 't')).toBeNull();
    // Owner names are path-encoded, so they cannot redirect the request elsewhere.
    await c.ownerType('../evil', null);
    expect(new URL(seen.at(-1)!.url).host).toBe('api.github.com');
    expect(seen.at(-1)!.url).toContain('..%2Fevil');
  });
});

describe('recentComments', () => {
  const c = (n: number) => ({
    id: n,
    user: { login: `u${n}` },
    created_at: `2026-11-0${n}T00:00:00Z`,
    body: `text ${n}`,
  });
  it('reads the last page of the comments, oldest first, in one request when it is full', async () => {
    const { c: gh, seen } = client(() => json([c(1), c(2), c(3), c(4)]));
    expect(await gh.recentComments('org/app', 7, 8, 't', 4)).toEqual([
      { author: 'u1', text: 'text 1', at: '2026-11-01T00:00:00.000Z' },
      { author: 'u2', text: 'text 2', at: '2026-11-02T00:00:00.000Z' },
      { author: 'u3', text: 'text 3', at: '2026-11-03T00:00:00.000Z' },
      { author: 'u4', text: 'text 4', at: '2026-11-04T00:00:00.000Z' },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.github.com/repos/org/app/issues/7/comments?per_page=4&page=2');
  });
  it('reads the page before too when the last one holds only a comment or two, never more than two requests', async () => {
    const { c: gh, seen } = client((url) => (url.endsWith('page=3') ? json([c(9)]) : json([c(5), c(6), c(7), c(8)])));
    const got = await gh.recentComments('org/app', 7, 9, 't', 4);
    expect(got.map((x) => x.author)).toEqual(['u6', 'u7', 'u8', 'u9']);
    expect(seen.map((s) => s.url.split('?')[1])).toEqual(['per_page=4&page=3', 'per_page=4&page=2']);
  });
  it('is empty with no comments, makes no request, and treats a missing issue as empty', async () => {
    const none = client(() => json([]));
    expect(await none.c.recentComments('org/app', 7, 0, 't')).toEqual([]);
    expect(none.seen).toHaveLength(0);
    expect(await client(() => json({}, {}, 404)).c.recentComments('org/app', 7, 2, 't')).toEqual([]);
  });
});

const user = { login: 'erin', avatar_url: 'https://a/e.png', type: 'User' };
const cmt = (id: number, at: string, over: Record<string, unknown> = {}) => ({
  id,
  user,
  author_association: 'MEMBER',
  body: `body ${id}`,
  html_url: `https://github.com/org/app/issues/7#issuecomment-${id}`,
  created_at: at,
  ...over,
});
const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();

describe('discussion mapping', () => {
  it('maps comments, skips empty COMMENTED and PENDING reviews, and links inline replies', () => {
    expect(mapIssueComment(cmt(5, at(1), { body: 'hi <!-- x -->' }))).toMatchObject({
      id: 'c5',
      kind: 'comment',
      author: 'erin',
      association: 'MEMBER',
      body: 'hi',
    });
    const review = (state: string, body: string) => ({ id: 9, user, state, body, submitted_at: at(2) });
    expect(mapReview(review('APPROVED', ''))).toMatchObject({ kind: 'review', reviewState: 'approved' });
    expect(mapReview(review('CHANGES_REQUESTED', 'no'))?.reviewState).toBe('changes_requested');
    expect(mapReview(review('COMMENTED', 'text'))?.reviewState).toBe('commented');
    expect(mapReview(review('COMMENTED', ''))).toBeNull();
    expect(mapReview(review('PENDING', 'draft'))).toBeNull();
    expect(
      mapInlineComment(cmt(3, at(3), { path: 'a.ts', line: null, original_line: 12, in_reply_to_id: 2 })),
    ).toMatchObject({ id: 'i3', kind: 'inline', path: 'a.ts', line: 12, replyTo: 'i2' });
    expect(mapInlineComment(cmt(3, at(3)))).toBeNull(); // no path: not an inline comment
  });

  it('treats a deleted author as ghost and ignores unknown associations', () => {
    expect(mapIssueComment(cmt(1, at(1), { user: null, author_association: 'WEIRD' }))).toMatchObject({
      author: 'ghost',
      association: null,
    });
  });

  it('reads the last page from a Link header', () => {
    const link =
      '<https://api.github.com/x?per_page=50&page=2>; rel="next", <https://api.github.com/x?per_page=50&page=7>; rel="last"';
    expect(lastPageOf(link)).toBe(7);
    expect(lastPageOf(null)).toBeNull();
  });
});

describe('discussion', () => {
  const link = (last: number) => ({
    link: `<https://api.github.com/x?per_page=50&page=2>; rel="next", <https://api.github.com/x?per_page=50&page=${last}>; rel="last"`,
  });

  it('fetches only issue comments for an issue, oldest first', async () => {
    const { c, seen } = client(() => json([cmt(2, at(2)), cmt(1, at(1))]));
    const d = await c.discussion('org/app', 7, 'issue', 'tok');
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/repos/org/app/issues/7/comments']);
    expect(d.entries.map((e) => e.id)).toEqual(['c1', 'c2']);
    expect(d.olderCut).toBe(false);
    expect(seen[0]!.headers.Authorization).toBe('Bearer tok');
  });

  it('merges comments, reviews and inline comments chronologically for a pull request', async () => {
    const { c, seen } = client((url) => {
      const p = new URL(url).pathname;
      if (p.endsWith('/issues/7/comments')) return json([cmt(1, at(1)), cmt(4, at(4))]);
      if (p.endsWith('/pulls/7/reviews')) {
        return json([
          { id: 2, user, state: 'CHANGES_REQUESTED', body: 'fix', submitted_at: at(2) },
          { id: 8, user, state: 'COMMENTED', body: '', submitted_at: at(2) },
        ]);
      }
      return json([cmt(3, at(3), { path: 'a.ts', line: 4 })]);
    });
    const d = await c.discussion('org/app', 7, 'pr', null);
    expect(seen).toHaveLength(3);
    expect(d.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['comment:c1', 'review:r2', 'inline:i3', 'comment:c4']);
  });

  it('keeps the newest 50 of a long thread, reading from the last pages, and says older ones were cut', async () => {
    // 120 comments: pages of 50, 50, 20.
    const pageOf = (n: number) =>
      Array.from({ length: n === 3 ? 20 : 50 }, (_, i) => cmt((n - 1) * 50 + i + 1, at((n - 1) * 50 + i + 1)));
    const { c, seen } = client((url) => json(pageOf(Number(new URL(url).searchParams.get('page'))), link(3)));
    const d = await c.discussion('org/app', 7, 'issue', null);
    expect(seen.map((s) => new URL(s.url).searchParams.get('page'))).toEqual(['1', '3', '2']);
    expect(d.entries).toHaveLength(50);
    expect(d.entries[0]!.id).toBe('c71');
    expect(d.entries.at(-1)!.id).toBe('c120');
    expect(d.olderCut).toBe(true);
  });

  it('keeps everything when the thread fits in one page', async () => {
    const many = Array.from({ length: 50 }, (_, i) => cmt(i + 1, at(i)));
    const d = await client(() => json(many)).c.discussion('org/app', 7, 'issue', null);
    expect(d.entries).toHaveLength(50);
    expect(d.olderCut).toBe(false);
  });

  it('fails clearly on 404, bad token and rate limits', async () => {
    await expect(client(() => json({}, {}, 404)).c.discussion('org/app', 7, 'issue', 't')).rejects.toMatchObject({
      status: 404,
    });
    await expect(client(() => json({}, {}, 401)).c.discussion('org/app', 7, 'issue', 't')).rejects.toThrow(/token/);
    await expect(
      client(() => json({}, { 'retry-after': '30' }, 429)).c.discussion('o/a', 1, 'pr', 't'),
    ).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('reviewsSince', () => {
  const review = (id: number, when: string | null, over: Record<string, unknown> = {}) => ({
    id,
    user,
    state: 'COMMENTED',
    body: '',
    submitted_at: when,
    ...over,
  });

  it('lists reviews submitted after a time in one request, inline-comment envelopes included, drafts left out', async () => {
    const { c, seen } = client(() =>
      json([
        review(1, at(1), { state: 'APPROVED', user: { login: 'old', type: 'User' } }),
        review(2, at(5), { state: 'CHANGES_REQUESTED', body: 'fix', user: { login: 'dave', type: 'User' } }),
        review(3, at(6), { user: { login: 'ci[bot]', type: 'Bot' } }), // an inline comment's envelope
        review(4, null, { state: 'PENDING' }), // my own unsent draft
      ]),
    );
    expect(await c.reviewsSince('org/app', 7, at(2), 't')).toEqual([
      { login: 'dave', type: 'User', at: at(5) },
      { login: 'ci[bot]', type: 'Bot', at: at(6) },
    ]);
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.github.com/repos/org/app/pulls/7/reviews?per_page=100&page=1',
    ]);
  });

  it('reads the last page as well when there are more than 100 reviews, and nothing for a vanished PR', async () => {
    const link = { link: '<https://api.github.com/x?per_page=100&page=3>; rel="last"' };
    const { c, seen } = client((url) =>
      new URL(url).searchParams.get('page') === '3' ? json([review(300, at(9))], link) : json([review(1, at(1))], link),
    );
    expect((await c.reviewsSince('org/app', 7, at(2), 't')).map((r) => r.at)).toEqual([at(9)]);
    expect(seen.map((s) => new URL(s.url).searchParams.get('page'))).toEqual(['1', '3']);
    expect(await client(() => json({}, {}, 404)).c.reviewsSince('org/app', 7, at(2), 't')).toEqual([]);
  });
});

describe('the REST (core) rate limit', () => {
  const rateHeaders = (resource: string | null, remaining: number) => ({
    'x-ratelimit-limit': resource === 'search' ? '30' : '5000',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': '1790000000',
    ...(resource ? { 'x-ratelimit-resource': resource } : {}),
  });

  it('remembers the latest core budget, and ignores the separate search budget', async () => {
    const { c } = client((url) =>
      url.includes('/search/') ? json({ items: [] }, rateHeaders('search', 3)) : json([], rateHeaders('core', 4321)),
    );
    expect(c.coreRate!()).toBeNull();
    await c.recentComments('org/app', 1, 1, 't');
    expect(c.coreRate!()).toEqual({ limit: 5000, remaining: 4321, resetAt: new Date(1790000000 * 1000).toISOString() });
    await c.search('q', 1, 't');
    expect(c.coreRate!()!.remaining).toBe(4321);
  });

  it('reads the budget off a rate-limited answer too', async () => {
    const { c } = client(() => json({ message: 'rate' }, rateHeaders('core', 0), 403));
    await expect(c.recentComments('org/app', 1, 1, 't')).rejects.toBeInstanceOf(GithubError);
    expect(c.coreRate!()!.remaining).toBe(0);
  });
});
