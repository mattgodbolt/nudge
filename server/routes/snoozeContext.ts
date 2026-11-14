import type { GithubClient, Repo } from '../contracts.js';

/** Most GitHub lookups one snooze request may cause; the rest are left without a commenter. */
export const MAX_SNOOZE_LOOKUPS = 20;
const DAY_MS = 86_400_000;

/**
 * Record, on each GitHub item's snooze event, who wrote the newest comment when it was snoozed, so we can later
 * check whether "my comment is the latest" predicts the owner's snoozes. Best effort by design: it runs after the
 * snooze has been answered, makes at most MAX_SNOOZE_LOOKUPS calls without retries, and never throws.
 */
export async function recordSnoozeContext(
  repo: Repo,
  client: GithubClient,
  actionId: number,
  ids: string[],
  log: (msg: string, err?: unknown) => void,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const mine = new Set(repo.getSettings().github.myAccounts.map((l) => l.toLowerCase()));
    const token = repo.getSettings().github.token;
    let lookups = 0;
    for (const it of repo.githubSnoozeContext(ids)) {
      const created = it.createdAt ? Date.parse(it.createdAt) : NaN;
      const base = {
        comments: it.comments,
        ageDays: Number.isFinite(created) ? Math.max(0, Math.floor((now() - created) / DAY_MS)) : null,
        itemKind: it.kind,
        draft: it.draft,
      };
      try {
        let who: string | null = null;
        if (it.comments > 0) {
          if (lookups >= MAX_SNOOZE_LOOKUPS) continue;
          lookups++;
          who = await client.latestCommenter(it.repo, it.number, it.comments, token);
        }
        repo.mergeSnoozeMeta(it.id, actionId, {
          ...base,
          lastCommenter: who,
          lastCommenterIsMe: who !== null && mine.has(who.toLowerCase()),
        });
      } catch (e) {
        log('snooze context lookup failed', e);
      }
    }
  } catch (e) {
    log('snooze context failed', e);
  }
}
