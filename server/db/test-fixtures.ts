import type { GithubItemUpsert, Repo } from '../contracts.js';
import { githubItemId } from './feeds.js';

/** Item id of PR/issue `n` in the `org/app` repo that most tests use. */
export const prId = (n: number): string => githubItemId('org', 'app', n);

/** An open, non-draft `org/app` PR upsert; tests override whatever they care about. */
export const githubPr = (n: number, over: Partial<GithubItemUpsert> = {}): GithubItemUpsert => ({
  id: prId(n),
  kind: 'pr',
  repo: 'org/app',
  number: n,
  title: `PR ${n}`,
  author: 'carol',
  authorAvatarUrl: null,
  authorType: 'User',
  association: 'CONTRIBUTOR',
  bodyPlain: 'body',
  url: `https://github.com/org/app/pull/${n}`,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  sourceState: 'open',
  draft: false,
  comments: 0,
  labels: [],
  ...over,
});

/** The `org` owner feed (PRs and issues, importing everything) that most tests start from. */
export const orgFeed = (repo: Repo) => repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' });
