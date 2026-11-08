import type { GithubAssociation } from '../../shared/types.js';
import type { GithubClient, GithubItemUpsert } from '../contracts.js';
import { githubItemId } from '../db/feeds.js';

export const DEMO_GITHUB_OWNER = 'demo-org';

interface Person {
  login: string;
  type: 'User' | 'Bot';
  association: GithubAssociation;
}
const PEOPLE: Person[] = [
  { login: 'alice-maintainer', type: 'User', association: 'MEMBER' },
  { login: 'bob-regular', type: 'User', association: 'CONTRIBUTOR' },
  { login: 'new-contributor', type: 'User', association: 'FIRST_TIME_CONTRIBUTOR' },
  { login: 'drive-by', type: 'User', association: 'NONE' },
  { login: 'dependabot[bot]', type: 'Bot', association: 'NONE' },
  { login: 'demo-owner', type: 'User', association: 'OWNER' },
];
const REPOS = ['demo-org/compiler', 'demo-org/infra', 'demo-org/docs'];
const TITLES = [
  'Fix crash when the input is empty',
  'Add support for the new target',
  'Bump the lockfile',
  'Document the build steps',
  'Speed up the parser',
  'Handle Windows line endings',
  'Refactor the options dialog',
  'Typo in the README',
];

/**
 * A fake GitHub for demo mode and e2e: a fixed set of pull requests and issues spread over the last few days, plus
 * `tick()` to make a new pull request arrive. Deterministic given the clock.
 */
export function createFakeGithubClient(now: () => number = Date.now) {
  const base = now();
  const items: GithubItemUpsert[] = [];
  let seq = 0;

  function add(ageHours: number, over: Partial<GithubItemUpsert> = {}): GithubItemUpsert {
    const i = seq++;
    const person = PEOPLE[i % PEOPLE.length]!;
    const repo = REPOS[i % REPOS.length]!;
    const number = 100 + i;
    const isPr = i % 3 !== 2;
    const created = new Date(base - ageHours * 3_600_000).toISOString();
    const it: GithubItemUpsert = {
      id: githubItemId(repo.split('/')[0]!, repo.split('/')[1]!, number),
      kind: isPr ? 'pr' : 'issue',
      repo,
      number,
      title: `${TITLES[i % TITLES.length]} (#${number})`,
      author: person.login,
      authorAvatarUrl: null,
      authorType: person.type,
      association: person.association,
      bodyPlain: `Demo ${isPr ? 'pull request' : 'issue'} body for #${number}.\n\nIt explains what changed and why.`,
      url: `https://github.com/${repo}/${isPr ? 'pull' : 'issues'}/${number}`,
      createdAt: created,
      updatedAt: created,
      sourceState: 'open',
      draft: false,
      comments: 0,
      labels: i % 4 === 0 ? ['bug'] : [],
      ...over,
    };
    items.push(it);
    return it;
  }

  for (let h = 90; h >= 2; h -= 3) add(h);

  return {
    /** A new pull request arrives (the demo "tick"). */
    tick(): void {
      add(0, { kind: 'pr', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() });
    },
    client: {
      async whoami() {
        return { login: 'demo-owner', scopes: ['public_repo'] };
      },
      async ownerType(owner) {
        return owner === DEMO_GITHUB_OWNER ? 'org' : null;
      },
      async search(q, page) {
        const m = /updated:>=(\S+)/.exec(q);
        const since = m ? Date.parse(m[1]!) : 0;
        const wantsPr = /\bis:pr\b/.test(q);
        const wantsIssue = /\bis:issue\b/.test(q);
        const hits = items
          .filter((i) => Date.parse(i.updatedAt) >= since)
          .filter((i) => (wantsPr ? i.kind === 'pr' : wantsIssue ? i.kind === 'issue' : true))
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        return { items: hits.slice((page - 1) * 100, page * 100), total: hits.length, rate: null };
      },
      async latestCommenter() {
        return null;
      },
    } satisfies GithubClient,
  };
}
