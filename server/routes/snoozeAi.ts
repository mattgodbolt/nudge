import type { FastifyInstance } from 'fastify';
import { BUCKETS } from '../../shared/snooze.js';
import type { AppDeps, LlmTokens } from '../contracts.js';
import { LlmError } from '../contracts.js';
import { costMicros } from '../classify/anthropic.js';
import { overDailyCap } from '../suggest/worker.js';
import { HttpError, logBackground, notFound } from './util.js';

/** Most items one snooze action will have bucketed by the model (a bulk snooze must not become a bulk bill). */
export const MAX_BUCKET_CALLS = 10;

function count(deps: AppDeps, model: string, tokens: LlmTokens | null): void {
  const micros = tokens ? costMicros(model, tokens) : 0;
  // The cap's ledger first and on its own: an analytics failure must not make a call free.
  deps.repo.spend.add('snooze_ai', micros);
  try {
    deps.repo.usage.add({
      'snooze_ai.call': 1,
      ...(tokens ? {} : { 'snooze_ai.fail': 1 }),
      ...(micros > 0 ? { 'snooze_ai.cost_micros': micros } : {}),
    });
  } catch (e) {
    console.error('usage counter failed', e);
  }
}

/**
 * After a snooze that gave a reason in words but no bucket: ask the model which bucket it fits and store it. Runs after
 * the snooze has been answered and never throws, never waits for anything the owner is waiting on; without a key, a
 * model, or budget it does nothing. The reason is untrusted text for the model (see classify/snooze.ts).
 */
export async function bucketInBackground(
  deps: AppDeps,
  actionId: number,
  ids: string[],
  log: (msg: string, err?: unknown) => void = logBackground,
): Promise<void> {
  try {
    const { apiKey, model } = deps.repo.getSettings().llm;
    if (!apiKey || !deps.snoozeAi) return;
    const changed: string[] = [];
    for (const id of ids.slice(0, MAX_BUCKET_CALLS)) {
      if (overDailyCap(deps.repo)) break;
      const found = deps.repo.getItem(id);
      const why = deps.repo.snoozeReason(id);
      if (!found || !why) continue;
      try {
        const r = await deps.snoozeAi.bucket({ why, title: found.item.title, kind: found.item.kind }, apiKey, model);
        count(deps, model, r.tokens);
        if (r.bucket && deps.repo.assignSnoozeBucket(id, actionId, r.bucket)) changed.push(id);
      } catch (e) {
        count(deps, model, null);
        log('snooze bucketing failed', e);
      }
    }
    if (changed.length > 0) {
      deps.bus.emit({ type: 'inbox.changed', counts: deps.repo.counts(), addedIds: [], changedIds: changed });
    }
  } catch (e) {
    log('snooze bucketing failed', e);
  }
}

export function registerSnoozeAiRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * A short follow-up comment for an item that came back after waiting on someone in vain. Only drafted for GitHub items
   * in a waiting_on_* bucket; shown to the owner to copy, and never posted by Nudge. The thread text goes to the model
   * as untrusted data, fetched here (one capped GitHub call) and never from the request.
   */
  app.post<{ Params: { id: string } }>('/api/items/:id/nudge-draft', async (req) => {
    const found = deps.repo.getItem(req.params.id);
    if (!found) throw notFound('Item');
    const g = found.item.github;
    const nag = deps.repo.snoozeNag(req.params.id);
    const bucket = nag?.bucket ?? null;
    if (found.item.provider !== 'github' || !g || !nag || !bucket || !bucket.startsWith('waiting_on_')) {
      throw new HttpError(
        409,
        'A nudge can only be drafted for a GitHub item that was waiting on someone',
        'not_applicable',
      );
    }
    const { apiKey, model } = deps.repo.getSettings().llm;
    if (!apiKey || !deps.snoozeAi)
      throw new HttpError(424, 'Add an Anthropic key in Settings to draft nudges', 'no_key');
    if (overDailyCap(deps.repo)) {
      throw new HttpError(429, 'The daily limit on model spending has been reached', 'cap');
    }
    const settings = deps.repo.getSettings();
    const mine = new Set(settings.github.myAccounts.map((l) => l.toLowerCase()));
    let comments: { author: string; isMatt: boolean; text: string }[] = [];
    try {
      const got =
        (await deps.githubClient?.recentComments(
          `${g.owner}/${g.repo}`,
          g.number,
          g.comments,
          settings.github.token,
          6,
        )) ?? [];
      comments = got.map((c) => ({
        author: c.author,
        isMatt: mine.has(c.author.toLowerCase()),
        text: c.text.replace(/\s+/g, ' ').trim(),
      }));
    } catch (e) {
      // The draft is still useful from the description alone.
      logBackground('nudge: could not fetch comments', e);
    }
    try {
      const r = await deps.snoozeAi.nudge(
        {
          title: found.item.title ?? '',
          kind: found.item.kind === 'pr' ? 'pr' : 'issue',
          bucket,
          days: nag.days,
          why: nag.why,
          comments,
          body: found.bodyPlain,
        },
        apiKey,
        model,
      );
      count(deps, model, r.tokens);
      return { text: r.text, bucket: BUCKETS[bucket].label };
    } catch (e) {
      count(deps, model, null);
      throw new HttpError(424, e instanceof LlmError ? e.message : 'Could not draft a nudge', 'llm_failed');
    }
  });
}
