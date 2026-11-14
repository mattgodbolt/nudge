import type { GithubAssociation, GithubDiscussionEntry } from '../../shared/types.js';
import { GithubError, type GithubClient, type GithubItemUpsert } from '../contracts.js';
import { githubItemId } from '../db/feeds.js';

export const DEMO_GITHUB_OWNER = 'demo-org';
/** A second owner with one small, quiet repository: what a single-repo feed is for. */
export const DEMO_QUIET_REPO = 'quiet-org/tiny';

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
export function createFakeGithubClient(
  now: () => number = Date.now,
  opts: { comments?: boolean; /** Extra, older items: a backlog to triage. */ backlog?: number } = {},
) {
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
      bodyPlain: `Demo ${isPr ? 'pull request' : 'issue'} body for #${number}.\n\nIt explains **what changed** and why.\n\n<details>\n<summary>Commits</summary>\n\n- first change\n- second change\n</details>`,
      url: `https://github.com/${repo}/${isPr ? 'pull' : 'issues'}/${number}`,
      createdAt: created,
      updatedAt: created,
      sourceState: 'open',
      draft: false,
      // With `comments`, every other item has a thread: 2 comments end on the owner's (so it is waiting on someone
      // else), 3 end on the maintainer's.
      comments: opts.comments && i % 2 === 1 ? (i % 4 === 1 ? 2 : 3) : 0,
      // Several, with long names: the inbox row has to cope on a phone.
      labels: i % 4 === 0 ? ['bug', 'discussion', 'accessibility', 'good first issue'] : [],
      ...over,
    };
    items.push(it);
    return it;
  }

  for (let h = 90; h >= 2; h -= 3) add(h);
  // A backlog: a few hundred older items (up to months old), as when a whole organisation is imported.
  for (let k = 0; k < (opts.backlog ?? 0); k++) add(100 + k * 7);

  // Appended after the rest so the numbering above does not move: three open items in a repo of its own.
  for (let k = 0; k < 3; k++) {
    const number = 7 + k;
    const created = new Date(base - (5 + k * 20) * 3_600_000).toISOString();
    items.push({
      ...items[k]!,
      id: githubItemId('quiet-org', 'tiny', number),
      repo: DEMO_QUIET_REPO,
      number,
      title: `Quiet repository item (#${number})`,
      url: `https://github.com/${DEMO_QUIET_REPO}/${k === 2 ? 'issues' : 'pull'}/${number}`,
      kind: k === 2 ? 'issue' : 'pr',
      createdAt: created,
      updatedAt: created,
      comments: 0,
      labels: [],
    });
  }

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
        return owner === DEMO_GITHUB_OWNER || owner === 'quiet-org' ? 'org' : null;
      },
      async repoExists(repo) {
        return items.some((i) => i.repo.toLowerCase() === repo.toLowerCase());
      },
      async search(q, page) {
        // Like the real API: a search must say which kind it wants.
        if (!/\bis:(pr|issue)\b/.test(q)) {
          throw new GithubError("GitHub said 422: Query must include 'is:issue' or 'is:pull-request'", 422);
        }
        const m = /updated:>=(\S+)/.exec(q);
        const since = m ? Date.parse(m[1]!) : 0;
        const wantsPr = /\bis:pr\b/.test(q);
        // Like the real API: `org:`/`user:` match an owner, `repo:` one repository.
        const scope = /\b(org|user|repo):(\S+)/.exec(q);
        const inScope = (i: GithubItemUpsert) =>
          !scope || (scope[1] === 'repo' ? i.repo : i.repo.split('/')[0]!).toLowerCase() === scope[2]!.toLowerCase();
        const hits = items
          .filter(inScope)
          .filter((i) => Date.parse(i.updatedAt) >= since)
          .filter((i) => (wantsPr ? i.kind === 'pr' : i.kind === 'issue'))
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        return { items: hits.slice((page - 1) * 100, page * 100), total: hits.length, rate: null };
      },
      async latestCommenter() {
        return null;
      },
      async recentComments(repo, number, commentCount) {
        // Deterministic: alternating the maintainer and the owner (who is "me" in demo mode), newest last.
        const it = items.find((i) => i.repo === repo && i.number === number);
        const t0 = Date.parse(it?.createdAt ?? new Date(base).toISOString());
        const n = Math.min(commentCount, 4);
        return Array.from({ length: n }, (_, k) => {
          const mine = (commentCount - n + k) % 2 === 1;
          return {
            author: mine ? 'demo-owner' : 'alice-maintainer',
            text: mine ? 'I will look at this properly soon.' : `Could you take another look at #${number}?`,
            at: new Date(t0 + (k + 1) * 600_000).toISOString(),
          };
        });
      },
      async discussion(repo, number, kind) {
        const it = items.find((i) => i.repo === repo && i.number === number);
        const t0 = Date.parse(it?.createdAt ?? new Date(base).toISOString());
        const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
        const maint = PEOPLE[0]!;
        const bot = PEOPLE[4]!;
        const entry = (n: number, p: Person, min: number, body: string): GithubDiscussionEntry => ({
          id: `c${number}${n}`,
          kind: 'comment',
          author: p.login,
          avatarUrl: null,
          authorType: p.type,
          association: p.association,
          createdAt: at(min),
          body,
          url: null,
        });
        const entries: GithubDiscussionEntry[] = [
          entry(1, bot, 1, 'Automated check finished: **all green**.'),
          entry(2, maint, 30, `Thanks! Could you add a test for #${number}?\n\n<img src=x onerror=alert(1)>`),
        ];
        if (kind === 'pr') {
          entries.push(
            {
              ...entry(3, maint, 45, 'Looks mostly fine, one nit inline.'),
              id: `r${number}3`,
              kind: 'review',
              reviewState: 'changes_requested',
            },
            {
              ...entry(4, maint, 46, 'Please rename this helper.'),
              id: `i${number}4`,
              kind: 'inline',
              path: 'src/parser.cpp',
              line: 42,
              replyTo: null,
            },
          );
        }
        return { entries, olderCut: false };
      },
    } satisfies GithubClient,
  };
}
