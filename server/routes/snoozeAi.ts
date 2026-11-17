import type { FastifyInstance } from 'fastify';
import { BUCKETS } from '../../shared/snooze.js';
import type { AppDeps, LlmTokens } from '../contracts.js';
import { LlmError } from '../contracts.js';
import { costMicros } from '../classify/anthropic.js';
import { overDailyCap } from '../suggest/worker.js';
import { ownerProfileComplete } from '../../shared/owner.js';
import { HttpError, logBackground, notFound, ownerProfileMissing } from './util.js';

/** Most items one snooze action will have bucketed by the model (a bulk snooze must not become a bulk bill). */
export const MAX_BUCKET_CALLS = 10;

/** Charge one call. A failed call is charged too when the model answered: a billed but unusable answer is not free. */
function count(deps: AppDeps, model: string, tokens: LlmTokens | null, failed = tokens === null): void {
  const micros = tokens ? costMicros(model, tokens) : 0;
  // The cap's ledger first and on its own: an analytics failure must not make a call free.
  deps.repo.spend.add('snooze_ai', micros);
  try {
    deps.repo.usage.add({
      'snooze_ai.call': 1,
      ...(failed ? { 'snooze_ai.fail': 1 } : {}),
      ...(micros > 0 ? { 'snooze_ai.cost_micros': micros } : {}),
    });
  } catch (e) {
    console.error('usage counter failed', e);
  }
}

/**
 * After a snooze that gave a reason in words but no bucket: ask the model which bucket it fits and store it. Runs after
 * the snooze has been answered and never throws, never waits for anything the owner is waiting on; without a key, a
 * model, a complete profile (Settings > About you) or budget it does nothing. The reason is untrusted text for the model (see classify/snooze.ts).
 */
export async function bucketInBackground(
  deps: AppDeps,
  actionId: number,
  ids: string[],
  log: (msg: string, err?: unknown) => void = logBackground,
): Promise<void> {
  try {
    const { llm, owner } = deps.repo.getSettings();
    const { apiKey, model } = llm;
    // Paused with the other model features until Settings > About you is filled in, so the banner there is the truth.
    if (!apiKey || !deps.snoozeAi || !ownerProfileComplete(owner)) return;
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
        count(deps, model, e instanceof LlmError ? e.tokens : null, true);
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
  app.post<{ Params: { id: string } }>('/api/items/:id/nudge-draft', async (req, reply) => {
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
    const settings = deps.repo.getSettings();
    // The draft is written as the owner: without their profile the model would be guessing who that is.
    if (!ownerProfileComplete(settings.owner)) return ownerProfileMissing(reply);
    if (overDailyCap(deps.repo)) {
      throw new HttpError(429, 'The daily limit on model spending has been reached', 'cap');
    }
    const mine = new Set(settings.github.myAccounts.map((l) => l.toLowerCase()));
    let comments: { author: string; isOwner: boolean; text: string }[] = [];
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
        isOwner: mine.has(c.author.toLowerCase()),
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
          author: found.item.author,
          bucket,
          days: nag.days,
          why: nag.why,
          comments,
          body: found.bodyPlain,
        },
        apiKey,
        model,
        settings.owner,
      );
      count(deps, model, r.tokens);
      return { text: r.text, bucket: BUCKETS[bucket].label };
    } catch (e) {
      count(deps, model, e instanceof LlmError ? e.tokens : null, true);
      throw new HttpError(424, e instanceof LlmError ? e.message : 'Could not draft a nudge', 'llm_failed');
    }
  });
}
