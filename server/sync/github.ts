import type { EventBus, FeedRow, GithubClient, GithubItemUpsert, GithubPoller, Repo } from '../contracts.js';
import { GithubError } from '../contracts.js';

export interface GithubPollerDeps {
  repo: Repo;
  bus: EventBus;
  client: GithubClient;
  clock?: () => Date;
  /** How often the loop looks for feeds that are due. */
  tickMs?: number;
  /** Time between polls of one feed. */
  intervalMs?: number;
  /** Search pages (100 each) per poll; a busier window continues on the next poll. */
  maxPages?: number;
  /** Per poll, how many "who commented last?" lookups to spend on Done items that gained comments. */
  maxCommenterLookups?: number;
}

/**
 * GitHub's search index lags a little behind reality, so every query re-reads a window before the last cursor.
 * Upserts are idempotent, so the overlap costs nothing but a few repeated rows.
 */
const OVERLAP_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const ghTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Polls each enabled feed on its own schedule, with its own queue and limits: GitHub is independent of YouTube's key
 * and quota. One feed is one search query ("everything in this owner updated since the cursor"); new items arrive in
 * the inbox, known ones are refreshed (closed, merged, commented on) by the repo's upsert rules.
 */
export function createGithubPoller(deps: GithubPollerDeps): GithubPoller & { tick(): Promise<void> } {
  const clock = deps.clock ?? (() => new Date());
  const intervalMs = deps.intervalMs ?? 5 * 60_000;
  const maxPages = deps.maxPages ?? 5;
  const maxLookups = deps.maxCommenterLookups ?? 10;
  const { repo, bus, client } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const announceFeeds = () => bus.emit({ type: 'feeds.changed', feeds: repo.listFeeds(), mutes: repo.listMuteRules() });

  async function pollFeed(feed: FeedRow): Promise<void> {
    const now = clock();
    const settings = repo.getSettings().github;
    const token = settings.token;
    const mine = new Set(settings.myAccounts.map((l) => l.toLowerCase()));
    try {
      // A repo feed is one `repo:` qualifier: no user/organisation lookup, only a check that the repository exists.
      let ownerType: 'org' | 'user' | null = null;
      if (feed.kind === 'repo') {
        if (!(await client.repoExists(feed.owner, token))) {
          throw new GithubError(`GitHub has no repository called "${feed.owner}"`, 404);
        }
      } else {
        ownerType = feed.ownerType ?? (await client.ownerType(feed.owner, token));
        if (!ownerType) throw new GithubError(`GitHub has no user or organisation called "${feed.owner}"`, 404);
      }
      const scope = feed.kind === 'repo' ? `repo:${feed.owner}` : `${ownerType}:${feed.owner}`;

      const since = feed.cursor
        ? new Date(Date.parse(feed.cursor) - OVERLAP_MS)
        : new Date(feed.baselineAt ?? now.toISOString());
      // The first import of "everything" would otherwise drag in years of closed items.
      const openOnly = !feed.cursor && feed.importMode === 'all' ? ' is:open' : '';
      // GitHub rejects a search that is neither is:pr nor is:issue (422), so each kind is its own query.
      const kinds = [...(feed.prs ? ['is:pr'] : []), ...(feed.issues ? ['is:issue'] : [])];

      const ups: GithubItemUpsert[] = [];
      let rate = null;
      // Where a kind that hit the page cap stopped: the next poll must resume from the earliest of these.
      const stoppedAt: string[] = [];
      for (const kind of kinds) {
        const q = `${scope} ${kind} updated:>=${ghTime(since)}${openOnly}`;
        let newestOfKind = '';
        for (let page = 1; page <= maxPages; page++) {
          const res = await client.search(q, page, token);
          rate = res.rate ?? rate;
          ups.push(...res.items);
          for (const u of res.items) if (u.updatedAt > newestOfKind) newestOfKind = u.updatedAt;
          if (res.items.length < 100) break;
          if (page === maxPages && newestOfKind) stoppedAt.push(newestOfKind);
        }
      }
      const truncated = stoppedAt.length > 0;

      // Done items that gained comments only come back if someone other than me wrote the newest one.
      const meta = repo.githubItemMeta(ups.map((u) => u.id));
      let lookups = 0;
      for (const u of ups) {
        const m = meta.get(u.id);
        if (!m || u.sourceState !== 'open' || u.comments <= m.comments) continue;
        if (!(m.state === 'done' || m.state === 'replied' || m.state === 'resolved')) continue;
        if (lookups++ >= maxLookups) break;
        const who = await client.latestCommenter(u.repo, u.number, u.comments, token).catch(() => null);
        if (who) {
          u.lastCommenterIsMe = mine.has(who.toLowerCase());
          u.lastCommenter = who;
        }
      }

      const result = repo.upsertGithubItems(feed.id, ups);
      repo.recordFeedPoll(feed.id, {
        // Truncated: continue from where the oldest-first results of the busiest kind ended (the other kind's items
        // are simply read again, harmlessly). Otherwise we are caught up.
        cursor: truncated ? stoppedAt.reduce((m, t) => (t < m ? t : m)) : now.toISOString(),
        ownerType,
        nextPollAt: truncated ? now.toISOString() : new Date(now.getTime() + intervalMs).toISOString(),
        errorCount: 0,
        error: null,
        rate,
      });
      const arrivals = [...result.added, ...result.reopened];
      if (arrivals.length > 0 || result.changed.length > 0) {
        bus.emit({
          type: 'inbox.changed',
          counts: repo.counts(),
          addedIds: arrivals,
          changedIds: result.changed.filter((id) => !arrivals.includes(id)),
          ...(arrivals.length > 0 ? { reason: 'sync' as const } : {}),
        });
      }
    } catch (e) {
      const n = feed.errorCount + 1;
      const retryAt = e instanceof GithubError ? e.retryAt : null;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (n - 1));
      const next = retryAt ?? new Date(now.getTime() + backoffMs).toISOString();
      repo.recordFeedPoll(feed.id, {
        nextPollAt: next,
        errorCount: n,
        backoffUntil: next,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    announceFeeds();
  }

  const run = (only?: number): Promise<void> => {
    // One poll at a time: GitHub's secondary rate limits dislike parallel searches, and it keeps the cursor simple.
    chain = chain.then(async () => {
      const rows = only === undefined ? repo.enabledFeedRows() : [repo.getFeedRow(only)].filter((f) => f?.enabled);
      for (const f of rows) if (f) await pollFeed(f);
    });
    return chain;
  };

  async function tick(): Promise<void> {
    const at = clock().toISOString();
    const due = repo.enabledFeedRows().filter((f) => (f.nextPollAt ?? '') <= at && (f.backoffUntil ?? '') <= at);
    await Promise.all(due.map((f) => run(f.id)));
  }

  return {
    tick,
    pollNow: (feedId) => run(feedId),
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), deps.tickMs ?? 60_000);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
