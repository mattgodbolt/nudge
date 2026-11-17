import type { Db } from '../db/db.js';
import { createRepo } from '../db/repo.js';
import type { SuggestionRow } from '../db/suggestions.js';
import { mulberry32 } from './world.js';

/**
 * Demo only (NUDGE_DEMO_HISTORY=1): a few weeks of made-up history so the Insights section has something to show. The
 * demo's items all arrive at once on the first sync, so this moves their arrival back over the last few weeks (at
 * plausible hours), then plays the owner's actions through the real repository with a clock set in the past:
 * replies, dones, dismissals, snoozes that wake, one bulk action and one undo, with suggestions saved first so the
 * prediction cards have something to judge. Deterministic (seeded), and it never runs against a real database: the
 * caller only calls it in demo mode, which refuses to start on one.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Spread arrivals over this many days. */
const SPAN_DAYS = 40;
const MIN_YOUTUBE = 60;
const MAX_ITEMS = 180;

/** Arrival weights by local (UTC) hour: quiet nights, a lunchtime bump and a busy late afternoon. */
const ARRIVAL_HOURS = [1, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6, 7, 6, 7, 8, 10, 11, 9, 7, 6, 5, 3, 2];
/** When the demo owner triages: mornings with coffee, a little after lunch, a bit in the evening. */
const ACTION_HOURS = [0, 0, 0, 0, 0, 0, 1, 4, 9, 10, 6, 3, 1, 3, 2, 1, 1, 1, 2, 4, 5, 3, 1, 0];
const CATEGORIES = ['question', 'technical', 'bug', 'idea', 'chat', 'support'] as const;

function weighted(rng: () => number, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]!;
    if (x < 0) return i;
  }
  return weights.length - 1;
}

/** Returns false (and changes nothing) until there are enough demo items to work with. */
export function seedDemoHistory(db: Db, nowMs: number = Date.now(), seed = 7): boolean {
  // Already has history from before today (this ran before): never twice. Today's decoration snoozes don't count.
  const past = db
    .prepare("SELECT COUNT(*) AS n FROM item_events WHERE source = 'user' AND at < ?")
    .get(new Date(nowMs - DAY).toISOString()) as { n: number };
  if (past.n > 0) return true;
  const rows = db
    .prepare(
      `SELECT id, provider FROM items WHERE state = 'inbox' AND snoozed_until IS NULL AND is_own = 0
         AND provider IN ('youtube', 'github') ORDER BY provider, id`,
    )
    .all() as { id: string; provider: string }[];
  if (rows.filter((r) => r.provider === 'youtube').length < MIN_YOUTUBE) return false;

  const rng = mulberry32(seed);
  const items = rows.slice(0, MAX_ITEMS);
  let clockMs = nowMs;
  const repo = createRepo(db, () => new Date(clockMs));
  const ops: { t: number; run: () => void }[] = [];
  const at = (t: number, run: () => void) => ops.push({ t, run });
  const iso = (t: number) => new Date(t).toISOString();

  /** A local (UTC) moment `days` back at a weighted hour. */
  const moment = (daysBack: number, weights: readonly number[]) => {
    const day = Math.floor(nowMs / DAY) - daysBack;
    return day * DAY + weighted(rng, weights) * HOUR + Math.floor(rng() * 60) * 60_000;
  };
  const suggest = (id: string, did: 'reply' | 'act' | 'skip') => {
    const agree = rng() < 0.74;
    const verdicts = { reply: 'needs_reply', act: 'needs_action', skip: 'no_reply_needed' } as const;
    const pick = agree ? did : (['reply', 'act', 'skip'] as const).filter((x) => x !== did)[Math.floor(rng() * 2)]!;
    const confidence = agree ? (rng() < 0.6 ? 'high' : 'medium') : rng() < 0.5 ? 'medium' : 'low';
    const row: SuggestionRow = {
      itemId: id,
      stateKey: 'demo-history',
      verdict: verdicts[pick],
      category: CATEGORIES[Math.floor(rng() * CATEGORIES.length)]!,
      confidence,
      reason: 'Demo suggestion',
      injectionAttempt: false,
      model: 'demo',
      promptVersion: 'demo-1',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      createdAt: iso(clockMs),
      turn: pick === 'reply' ? 'me' : rng() < 0.7 ? 'them' : 'nobody',
    };
    repo.suggestions.save(row);
  };

  const setArrival = db.prepare(
    'UPDATE items SET first_seen_at = ?, occurred_at = ?, state_changed_at = ? WHERE id = ? AND state = ?',
  );
  const waiting: { id: string; arrival: number }[] = [];
  // Everything else the demo synced also arrived "just now"; spread it over the weeks too, so the arrival heatmap
  // shows a rhythm rather than one hot square at startup.
  const chosen = new Set(items.map((i) => i.id));
  const others = (
    db.prepare("SELECT id FROM items WHERE is_own = 0 AND provider IN ('youtube', 'github') ORDER BY id").all() as {
      id: string;
    }[]
  ).filter((r) => !chosen.has(r.id));
  const spread = db.prepare('UPDATE items SET first_seen_at = ?, occurred_at = ? WHERE id = ?');
  db.transaction(() => {
    for (const o of others) {
      const t = Math.min(nowMs - HOUR, moment(Math.floor(rng() * SPAN_DAYS * 1.5), ARRIVAL_HOURS));
      spread.run(iso(t), iso(t - Math.floor(rng() * 20) * 60_000), o.id);
    }
  })();
  db.transaction(() => {
    items.forEach((it, k) => {
      const arrival = Math.min(nowMs - HOUR, moment(Math.floor(rng() * SPAN_DAYS), ARRIVAL_HOURS));
      setArrival.run(iso(arrival), iso(arrival - Math.floor(rng() * 20) * 60_000), iso(arrival), it.id, 'inbox');
      // When the owner gets to it: the next triage session, a day or three later (or the same day).
      let act = moment(Math.floor((nowMs - arrival) / DAY) - Math.floor(rng() * 3), ACTION_HOURS);
      while (act <= arrival) act += DAY;
      if (act >= nowMs) {
        waiting.push({ id: it.id, arrival });
        return;
      }
      const roll = k % 10;
      if (roll <= 2) {
        at(act, () => {
          suggest(it.id, 'reply');
          repo.triage([it.id], 'replied');
        });
      } else if (roll <= 4) {
        at(act, () => {
          suggest(it.id, 'act');
          repo.triage([it.id], 'done');
        });
      } else if (roll === 5) {
        at(act, () => {
          suggest(it.id, 'skip');
          repo.triage([it.id], 'done', 'no_action');
        });
      } else if (roll === 6 && act + 3 * DAY < nowMs) {
        // Parked for a couple of days, woken (by its date), then dealt with.
        const until = act + 2 * DAY;
        at(act, () => {
          suggest(it.id, 'act');
          repo.snooze([it.id], iso(until), null, { bucket: 'waiting_on_them', untilActivity: rng() < 0.5 });
        });
        at(until + 60_000, () => repo.wakeSnoozed());
        at(until + 4 * HOUR, () => repo.triage([it.id], rng() < 0.5 ? 'done' : 'replied'));
      } else waiting.push({ id: it.id, arrival });
    });
  })();

  // One bulk clear-out of a few old ones, and one change of mind.
  const old = waiting.filter((w) => w.arrival < nowMs - 20 * DAY).slice(0, 6);
  if (old.length > 1) {
    at(nowMs - 6 * DAY + 9 * HOUR, () =>
      repo.triage(
        old.map((w) => w.id),
        'done',
      ),
    );
  }
  const regret = waiting.find((w) => w.arrival < nowMs - 3 * DAY && !old.includes(w));
  if (regret) {
    at(nowMs - 2 * DAY + 10 * HOUR, () => {
      const r = repo.triage([regret.id], 'done');
      clockMs += 60_000;
      repo.undo(r.actionId);
    });
  }

  ops.sort((a, b) => a.t - b.t);
  db.transaction(() => {
    for (const op of ops) {
      clockMs = Math.max(clockMs === nowMs ? 0 : clockMs, op.t);
      op.run();
    }
  })();
  return true;
}
