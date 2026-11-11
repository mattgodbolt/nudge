import type { GithubDiscussionDTO } from '../../../shared/types.js';
import type { GithubClient } from '../../contracts.js';
import { GithubError } from '../../contracts.js';

const TTL_MS = 3 * 60_000;
const MAX_CACHED = 200;

export interface DiscussionTarget {
  id: string;
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  /** The item's comment count from the last sync: a change means the cached conversation is stale. */
  comments: number;
  sourceState: string | null;
}

/**
 * Live conversations for the detail pane, kept for a few minutes so flicking between items (or reopening one) does
 * not spend GitHub's rate limit. The key includes the comment count and state, so a sync that notices a new comment
 * does not serve the old conversation. Reviews and inline comments do not move the count, hence the short TTL.
 */
export function createDiscussionService(opts: {
  client: GithubClient;
  getToken: () => string | null;
  clock?: () => number;
}) {
  const clock = opts.clock ?? Date.now;
  const cache = new Map<string, { at: number; dto: GithubDiscussionDTO }>();
  /** After a rate-limit answer, make no calls until GitHub says the window reopens. */
  let blockedUntil = 0;

  return {
    async get(t: DiscussionTarget): Promise<GithubDiscussionDTO> {
      const key = `${t.id}|${t.comments}|${t.sourceState ?? ''}`;
      const hit = cache.get(key);
      if (hit && clock() - hit.at < TTL_MS) return hit.dto;
      if (clock() < blockedUntil) {
        throw new GithubError(
          'GitHub rate limit reached; try again shortly',
          429,
          new Date(blockedUntil).toISOString(),
        );
      }
      try {
        const got = await opts.client.discussion(t.repo, t.number, t.kind, opts.getToken());
        const dto: GithubDiscussionDTO = { ...got, fetchedAt: new Date(clock()).toISOString() };
        cache.delete(key); // re-insert so the oldest-first eviction below is least-recently-fetched
        cache.set(key, { at: clock(), dto });
        for (const k of cache.keys()) {
          if (cache.size <= MAX_CACHED) break;
          cache.delete(k);
        }
        return dto;
      } catch (e) {
        if (e instanceof GithubError && e.retryAt) blockedUntil = Math.max(blockedUntil, Date.parse(e.retryAt) || 0);
        throw e;
      }
    },
  };
}
