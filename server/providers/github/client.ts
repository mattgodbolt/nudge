import type { GithubAssociation } from '../../../shared/types.js';
import { GithubError } from '../../contracts.js';
import type { GithubClient, GithubItemUpsert, GithubRate, GithubSearchPage } from '../../contracts.js';
import { githubItemId } from '../../db/feeds.js';

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
  const s = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
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

export function createGithubClient(opts: { fetch?: typeof fetch } = {}): GithubClient {
  const f = opts.fetch ?? fetch;

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

  return {
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
  };
}
