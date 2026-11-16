import type { GithubAssociation, GithubDiscussionEntry } from '../../../shared/types.js';
import { GithubError } from '../../contracts.js';
import type {
  GithubClient,
  GithubDiscussion,
  GithubItemUpsert,
  GithubRate,
  GithubSearchPage,
} from '../../contracts.js';
import { githubItemId } from '../../db/feeds.js';
import { stripBetween } from '../../db/text.js';

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const BODY_MAX = 4000;
const ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'MANNEQUIN',
  'NONE',
]);

/** Entries fetched per endpoint, and kept in the merged conversation. A thread longer than this shows its tail. */
const PAGE = 50;
const MERGED_MAX = 100;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function rateOf(h: Headers): GithubRate | null {
  const limit = Number(h.get('x-ratelimit-limit'));
  const remaining = Number(h.get('x-ratelimit-remaining'));
  const reset = Number(h.get('x-ratelimit-reset'));
  if (![limit, remaining, reset].every(Number.isFinite) || !h.get('x-ratelimit-limit')) return null;
  return { limit, remaining, resetAt: new Date(reset * 1000).toISOString() };
}

/** Markdown bodies carry HTML comments (issue templates) that are noise in a list; trim and cap the rest. */
export function cleanBody(body: unknown): string {
  if (typeof body !== 'string') return '';
  const s = stripBetween(body, '<!--', '-->').replace(/\r\n/g, '\n').trim();
  return s.length > BODY_MAX ? `${s.slice(0, BODY_MAX)}…` : s;
}

/** Map one /search/issues result. Exported for tests. */
export function mapSearchItem(it: Json): GithubItemUpsert | null {
  const repoUrl = typeof it.repository_url === 'string' ? it.repository_url : '';
  const parts = repoUrl.split('/').slice(-2);
  if (parts.length !== 2 || !parts[0] || !parts[1] || typeof it.number !== 'number') return null;
  const [owner, name] = parts as [string, string];
  const isPr = !!it.pull_request;
  const state: 'open' | 'closed' | 'merged' =
    it.state === 'open' ? 'open' : it.pull_request?.merged_at ? 'merged' : 'closed';
  const assoc = typeof it.author_association === 'string' && ASSOCIATIONS.has(it.author_association);
  return {
    id: githubItemId(owner, name, it.number),
    kind: isPr ? 'pr' : 'issue',
    repo: `${owner}/${name}`,
    number: it.number,
    title: String(it.title ?? ''),
    author: String(it.user?.login ?? 'ghost'),
    authorAvatarUrl: typeof it.user?.avatar_url === 'string' ? it.user.avatar_url : null,
    authorType: typeof it.user?.type === 'string' ? it.user.type : null,
    association: assoc ? (it.author_association as GithubAssociation) : null,
    bodyPlain: cleanBody(it.body),
    url: String(it.html_url ?? `https://github.com/${owner}/${name}/${isPr ? 'pull' : 'issues'}/${it.number}`),
    createdAt: new Date(it.created_at).toISOString(),
    updatedAt: new Date(it.updated_at).toISOString(),
    sourceState: state,
    draft: !!it.draft,
    comments: typeof it.comments === 'number' ? it.comments : 0,
    labels: Array.isArray(it.labels) ? it.labels.map((l: Json) => String(l?.name ?? '')).filter(Boolean) : [],
  };
}

const assocOf = (v: unknown): GithubAssociation | null =>
  typeof v === 'string' && ASSOCIATIONS.has(v) ? (v as GithubAssociation) : null;

const REVIEW_STATES: Record<string, NonNullable<GithubDiscussionEntry['reviewState']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

function person(u: Json | null | undefined, association: unknown) {
  return {
    author: typeof u?.login === 'string' ? u.login : 'ghost',
    avatarUrl: typeof u?.avatar_url === 'string' ? u.avatar_url : null,
    authorType: typeof u?.type === 'string' ? u.type : null,
    association: assocOf(association),
  };
}

const ts = (v: unknown): string | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** An issue or PR conversation comment. Exported for tests. */
export function mapIssueComment(c: Json): GithubDiscussionEntry | null {
  const createdAt = ts(c.created_at);
  if (!createdAt || c.id === undefined) return null;
  return {
    id: `c${c.id}`,
    kind: 'comment',
    ...person(c.user, c.author_association),
    createdAt,
    body: cleanBody(c.body),
    url: typeof c.html_url === 'string' ? c.html_url : null,
  };
}

/**
 * A pull request review. A "commented" review with no text is only the envelope around inline comments (which are
 * listed on their own), and a pending review is someone's unsent draft: both are noise here.
 */
export function mapReview(r: Json): GithubDiscussionEntry | null {
  const reviewState = REVIEW_STATES[String(r.state)];
  const createdAt = ts(r.submitted_at);
  if (!reviewState || !createdAt || r.id === undefined) return null;
  const body = cleanBody(r.body);
  if (reviewState === 'commented' && !body) return null;
  return {
    id: `r${r.id}`,
    kind: 'review',
    ...person(r.user, r.author_association),
    createdAt,
    body,
    url: typeof r.html_url === 'string' ? r.html_url : null,
    reviewState,
  };
}

/** An inline review comment on a diff. Exported for tests. */
export function mapInlineComment(c: Json): GithubDiscussionEntry | null {
  const createdAt = ts(c.created_at);
  if (!createdAt || c.id === undefined || typeof c.path !== 'string') return null;
  const line = c.line ?? c.original_line;
  return {
    id: `i${c.id}`,
    kind: 'inline',
    ...person(c.user, c.author_association),
    createdAt,
    body: cleanBody(c.body),
    url: typeof c.html_url === 'string' ? c.html_url : null,
    path: c.path,
    line: typeof line === 'number' ? line : null,
    replyTo: c.in_reply_to_id !== undefined && c.in_reply_to_id !== null ? `i${c.in_reply_to_id}` : null,
  };
}

/** The last page number from a Link header, or null when there is only one page. */
export function lastPageOf(link: string | null): number | null {
  const m = link && /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  return m ? Number(m[1]) : null;
}

export function createGithubClient(opts: { fetch?: typeof fetch } = {}): GithubClient {
  const f = opts.fetch ?? fetch;

  /** The latest REST ("core") budget GitHub reported; search responses carry their own, separate one. */
  let core: GithubRate | null = null;

  async function call(path: string, token: string | null): Promise<{ res: Response; body: Json | Json[] | null }> {
    let res: Response;
    try {
      res = await f(`${API}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nudge',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new GithubError(`Could not reach GitHub: ${e instanceof Error ? e.message : 'network error'}`, 0);
    }
    const resource = res.headers.get('x-ratelimit-resource');
    if (resource === null || resource === 'core') core = rateOf(res.headers) ?? core;
    if (res.status === 401) throw new GithubError('GitHub rejected the token (expired or revoked?)', 401);
    if (res.status === 403 || res.status === 429) {
      const rate = rateOf(res.headers);
      const retryHeader = res.headers.get('retry-after');
      const limited = res.status === 429 || rate?.remaining === 0 || retryHeader !== null;
      if (limited) {
        const retryAt =
          retryHeader !== null && Number.isFinite(Number(retryHeader))
            ? new Date(Date.now() + Number(retryHeader) * 1000).toISOString()
            : (rate?.resetAt ?? new Date(Date.now() + 60_000).toISOString());
        throw new GithubError('GitHub rate limit reached; will retry automatically', res.status, retryAt);
      }
      throw new GithubError('GitHub refused the request (does the token have access?)', res.status);
    }
    if (res.status >= 500) throw new GithubError(`GitHub is unavailable (${res.status})`, res.status);
    if (res.status === 404) return { res, body: null };
    if (!res.ok) {
      const msg = ((await res.json().catch(() => null)) as Json | null)?.message;
      throw new GithubError(`GitHub said ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
    }
    return { res, body: (await res.json()) as Json | Json[] };
  }

  /**
   * The newest PAGE items of a list endpoint that returns oldest first. Page 1 reveals (via the Link header) how many
   * pages there are; the tail is then read from the last page, plus the one before it when the last is short.
   */
  async function newest(path: string, token: string | null): Promise<{ items: Json[]; cut: boolean }> {
    const url = (page: number) => `${path}?per_page=${PAGE}&page=${page}`;
    const first = await call(url(1), token);
    // call() turns a 404 into a null body; here it means the item or repo is gone or invisible to this token.
    if (!Array.isArray(first.body)) throw new GithubError('GitHub could not find that conversation', first.res.status);
    const last = lastPageOf(first.res.headers.get('link'));
    if (!last || last < 2) return { items: first.body.slice(-PAGE), cut: first.body.length > PAGE };
    const tail: Json[] = [];
    for (let page = last; page >= 1 && tail.length < PAGE; page--) {
      const got = page === 1 ? first : await call(url(page), token);
      if (Array.isArray(got.body)) tail.unshift(...got.body);
    }
    return { items: tail.slice(-PAGE), cut: true };
  }

  return {
    coreRate: () => core,

    async whoami(token) {
      const { res, body } = await call('/user', token);
      if (!body || Array.isArray(body)) throw new GithubError('Unexpected answer from GitHub', res.status);
      const scopes = res.headers.get('x-oauth-scopes');
      return {
        login: String(body.login),
        // Fine-grained tokens send no scope header: unknown rather than empty.
        scopes:
          scopes === null
            ? null
            : scopes
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
      };
    },

    async ownerType(owner, token) {
      const { body } = await call(`/users/${encodeURIComponent(owner)}`, token);
      if (!body || Array.isArray(body)) return null;
      return body.type === 'Organization' ? 'org' : body.type === 'User' ? 'user' : null;
    },

    async repoExists(repo, token) {
      const [owner = '', name = ''] = repo.split('/');
      const { body } = await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token);
      return !!body && !Array.isArray(body);
    },

    async search(q, page, token): Promise<GithubSearchPage> {
      const params = new URLSearchParams({ q, sort: 'updated', order: 'asc', per_page: '100', page: String(page) });
      const { res, body } = await call(`/search/issues?${params}`, token);
      if (!body || Array.isArray(body)) throw new GithubError('Unexpected answer from GitHub search', res.status);
      const items = (Array.isArray(body.items) ? body.items : [])
        .map((i: Json) => mapSearchItem(i))
        .filter((i: GithubItemUpsert | null): i is GithubItemUpsert => i !== null);
      return { items, total: Number(body.total_count ?? items.length), rate: rateOf(res.headers) };
    },

    async latestCommenter(repo, number, commentCount, token) {
      if (commentCount < 1) return null;
      const [owner, name] = repo.split('/');
      // One comment per page, so the last page is the newest comment.
      const { body } = await call(
        `/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/issues/${number}/comments?per_page=1&page=${commentCount}`,
        token,
      );
      const last = Array.isArray(body) ? body[0] : null;
      return typeof last?.user?.login === 'string' ? last.user.login : null;
    },

    async recentComments(repo, number, commentCount, token, limit = 5) {
      if (commentCount < 1) return [];
      const [owner, name] = repo.split('/');
      const base = `/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/issues/${number}/comments`;
      // Pages of `limit` counted from the oldest: the last page holds the newest comments, but may hold only one or
      // two, so the page before it is read as well (never more than two requests).
      const lastPage = Math.ceil(commentCount / limit);
      const pageOf = async (page: number): Promise<Json[]> => {
        const { body } = await call(`${base}?per_page=${limit}&page=${page}`, token);
        return Array.isArray(body) ? body : [];
      };
      let raw = await pageOf(lastPage);
      if (raw.length < Math.min(3, commentCount) && lastPage > 1) raw = [...(await pageOf(lastPage - 1)), ...raw];
      return raw
        .slice(-limit)
        .map((c) => mapIssueComment(c))
        .filter((e): e is GithubDiscussionEntry => e !== null)
        .map((e) => ({ author: e.author, text: e.body, at: e.createdAt }));
    },

    async discussion(repo, number, kind, token): Promise<GithubDiscussion> {
      const [owner, name] = repo.split('/');
      const base = `/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`;
      const lists = [{ ...(await newest(`${base}/issues/${number}/comments`, token)), map: mapIssueComment }];
      if (kind === 'pr') {
        const reviews = await newest(`${base}/pulls/${number}/reviews`, token);
        const inline = await newest(`${base}/pulls/${number}/comments`, token);
        lists.push({ ...reviews, map: mapReview }, { ...inline, map: mapInlineComment });
      }
      const all = lists
        .flatMap((l) => l.items.map((i) => l.map(i)))
        .filter((e): e is GithubDiscussionEntry => e !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return {
        entries: all.slice(-MERGED_MAX),
        olderCut: lists.some((l) => l.cut) || all.length > MERGED_MAX,
      };
    },
  };
}
