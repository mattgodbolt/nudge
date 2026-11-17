import type { EventBus, FeedRow, GithubClient, GithubItemUpsert, GithubPoller, Repo } from '../contracts.js';
import { GithubError } from '../contracts.js';
import { DONE_LIKE } from '../db/feeds.js';

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
  /**
   * Per poll, how many lookups to spend on Done or parked items: "who commented last?" for those that gained comments,
   * then "any reviews since?" for PRs that moved.
   */
  maxCommenterLookups?: number;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * GitHub's search index lags a little behind reality, so every query re-reads a window before the last cursor.
 * Upserts are idempotent, so the overlap costs nothing but a few repeated rows.
 */
const OVERLAP_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const ghTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** GitHub Apps review as `name[bot]` with type 'Bot'; neither should wake anything. */
const isBot = (login: string, type: string | null) => type === 'Bot' || login.toLowerCase().endsWith('[bot]');

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
  /**
   * Feeds whose last poll stopped at the page cap, with the cursor it stopped at. Kept in memory only: after a restart
   * one poll re-reads its overlap, and the next resumes exactly.
   */
  const resumeAt = new Map<number, string>();
  const log =
    deps.log ?? ((m: string, e?: unknown) => console.warn(`github: ${m}`, e instanceof Error ? e.message : (e ?? '')));

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

      // Resuming a window the last poll cut short starts exactly where it stopped: with the overlap, a burst of more
      // items than the page cap inside 15 minutes would be read again from the same place on every poll.
      const resuming = feed.cursor !== null && resumeAt.get(feed.id) === feed.cursor;
      const since = feed.cursor
        ? new Date(Date.parse(feed.cursor) - (resuming ? 0 : OVERLAP_MS))
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

      // Done items that gained comments only come back if someone other than me wrote the newest one. The same
      // question decides whether an item parked until activity wakes, so it shares the lookups (and their cap).
      const meta = repo.githubItemMeta(ups.map((u) => u.id));
      let lookups = 0;
      for (const u of ups) {
        const m = meta.get(u.id);
        if (!m || u.sourceState !== 'open' || u.comments <= m.comments) continue;
        if (!(DONE_LIKE.has(m.state) || m.snoozedUntilActivity)) continue;
        // Past the cap, or when the lookup fails, the answer stays unknown (lastCommenterIsMe undefined): the upsert
        // then keeps the old comment count so the next poll asks again, rather than guessing either way.
        if (lookups++ >= maxLookups) break;
        let who: string | null;
        try {
          who = await client.latestCommenter(u.repo, u.number, u.comments, token);
        } catch {
          continue;
        }
        // No comment to be found (deleted since the count was taken): not mine, as before.
        u.lastCommenterIsMe = who !== null && mine.has(who.toLowerCase());
        if (who) u.lastCommenter = who;
      }

      // Reviews and inline review comments leave the comment count alone, so an open PR that moved since Nudge last
      // took it in, while Done or parked, is asked about its reviews instead: one request per move, from the same
      // capped budget (comment lookups go first). A push or CI run moves a PR too; those find no qualifying review.
      // The upsert repeats these conditions to tell "no review" from "not asked".
      for (const u of ups) {
        const m = meta.get(u.id);
        if (!m || u.kind !== 'pr' || u.sourceState !== 'open') continue;
        if (!(DONE_LIKE.has(m.state) || m.snoozedUntilActivity)) continue;
        if (m.seenUpdatedAt === null || u.updatedAt <= m.seenUpdatedAt) continue;
        if (u.lastCommenterIsMe === false) continue; // someone else's comment brings it back already
        if (lookups++ >= maxLookups) break;
        try {
          const reviews = await client.reviewsSince(u.repo, u.number, m.seenUpdatedAt, token);
          const theirs = reviews.filter((r) => !mine.has(r.login.toLowerCase()) && !isBot(r.login, r.type));
          u.reviewer = theirs.at(-1)?.login ?? null;
        } catch {
          // Left unknown: the upsert keeps the last seen update, so the next poll asks again.
        }
      }

      const result = repo.upsertGithubItems(feed.id, ups);
      // Truncated: continue from where the oldest-first results of the busiest kind ended (the other kind's items
      // are simply read again, harmlessly). Otherwise we are caught up.
      let cursor = truncated ? stoppedAt.reduce((m, t) => (t < m ? t : m)) : now.toISOString();
      // Only the overlap was re-read before the page cap stopped it: never step back into it, or a burst inside those
      // 15 minutes would be read from the same place again and again. Resume from the old cursor instead.
      if (truncated && feed.cursor && cursor < feed.cursor) cursor = feed.cursor;
      if (truncated) resumeAt.set(feed.id, cursor);
      else resumeAt.delete(feed.id);
      repo.recordFeedPoll(feed.id, {
        cursor,
        ownerType,
        nextPollAt: truncated ? now.toISOString() : new Date(now.getTime() + intervalMs).toISOString(),
        errorCount: 0,
        error: null,
        rate,
      });
      // Woken items are announced as a wake (a snooze ending), not as a new arrival: push settings tell them apart.
      if (result.woken.length > 0) {
        bus.emit({
          type: 'inbox.changed',
          counts: repo.counts(),
          addedIds: result.woken,
          changedIds: [],
          reason: 'woke',
        });
      }
      const arrivals = [...result.added, ...result.reopened];
      if (arrivals.length > 0 || result.changed.length > 0) {
        bus.emit({
          type: 'inbox.changed',
          counts: repo.counts(),
          addedIds: arrivals,
          changedIds: result.changed.filter((id) => !arrivals.includes(id) && !result.woken.includes(id)),
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
    // Each poll handles GitHub's own errors; anything else (the database, the event bus) is logged here and must not
    // leave the chain rejected, or every later poll would return that rejection without polling.
    chain = chain
      .then(async () => {
        const rows = only === undefined ? repo.enabledFeedRows() : [repo.getFeedRow(only)].filter((f) => f?.enabled);
        for (const f of rows) {
          if (!f) continue;
          try {
            await pollFeed(f);
          } catch (e) {
            log(`polling ${f.owner} failed`, e);
          }
        }
      })
      .catch((e) => log('poll failed', e));
    return chain;
  };

  async function tick(): Promise<void> {
    try {
      const at = clock().toISOString();
      const due = repo.enabledFeedRows().filter((f) => (f.nextPollAt ?? '') <= at && (f.backoffUntil ?? '') <= at);
      await Promise.all(due.map((f) => run(f.id)));
    } catch (e) {
      log('tick failed', e);
    }
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
