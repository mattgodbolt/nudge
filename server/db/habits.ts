import type { Db } from './db.js';

/**
 * Read-only summary of how the owner triages, computed from item_events (and items for provider/kind/arrival time).
 * Counts and durations only: no item text, titles, authors or ids appear in the output. The one exception is the
 * latest few notes the owner made himself (clipped), which he asked to see.
 */
/**
 * What a user state event to 'done' was. Events written since dismissals existed carry meta.reason ('done' or
 * 'no_action'); a bare done from before that could have meant either, so it is kept apart rather than guessed at.
 */
export const LEGACY_DONE = 'done (before dismissals existed)';

export interface SuggestionHit {
  suggested: string;
  /** Items judged: those whose first action says whether the suggestion was right. Excludes `ambiguous`. */
  total: number;
  hits: number;
  /** First action was a bare done from before dismissals existed: it cannot be said to agree or disagree. */
  ambiguous: number;
  byAction: Record<string, number>;
  /** Of those, by whose turn the model said it was (`none` = it did not say). */
  byTurn: Record<string, number>;
}

export interface HabitsReport {
  events: number;
  /** User state/snooze/decision counts by provider, item kind and action. */
  actionMix: { provider: string; kind: string; action: string; count: number }[];
  /** Median ms from first_seen_at to the first user action on the item, by provider. */
  timeToFirstActionMs: { provider: string; items: number; medianMs: number }[];
  snooze: { snoozed: number; woken: number; actionedAfterWake: number };
  /** Snoozes of GitHub items by the context recorded with them; `unknown` = no context was recorded. */
  snoozeContext: {
    byLastCommenter: { mine: number; theirs: number; unknown: number };
    byComments: { '0': number; '1-3': number; '4+': number; unknown: number };
    byItemKind: Record<string, number>;
  };
  /**
   * What snoozing "until activity" is worth: snoozes by reason bucket (`none` = no bucket), how each until-activity
   * snooze ended (something happened, the fallback date arrived with nothing, or the owner unsnoozed it himself),
   * how long it took, and what he did next with items that came back with no activity.
   */
  snoozeBuckets: {
    byBucket: Record<string, number>;
    untilActivity: number;
    wakeCauses: { activity: number; fallback: number; manual: number };
    medianMsToWake: { activity: number | null; fallback: number | null; manual: number | null };
    afterFallback: { done: number; dismissed: number; resnoozed: number; other: number; none: number };
  };
  decisions: { total: number; withRank: number; rank0: number; deeper: number; byInput: Record<string, number> };
  /** Items that sat above an acted-on item: later actioned by the owner, or still not. */
  passedOver: { pairs: number; laterActioned: number; left: number };
  /**
   * Suggestion hit rate: for each item that had a suggestion when the owner first dealt with it (done, replied or
   * snoozed), what the suggestion was against what he did. `hits` counts the agreeing actions: reply is hit by
   * replied; act by done or snooze; skip and spam by dismissed ("no action needed"). Items with no suggestion are not
   * counted. A done from before dismissals existed does not say whether he meant "I did it" or "nothing needed", so
   * for act, skip and spam it is reported as `ambiguous` and left out of total and hits.
   */
  suggestionHits: SuggestionHit[];
  /**
   * The same measure for items actioned as part of a bulk action (several items in one go, or a decision event flagged
   * `bulk`). Kept apart: a "done" on forty old items says nothing about whether the suggestion on each was right, so
   * it must not move the one-at-a-time rate.
   */
  suggestionHitsBulk: SuggestionHit[];
  /** Totals behind the two lists above: `single` is one-at-a-time decisions, `bulk` the shown-separately ones. */
  suggestionSummary: {
    single: { total: number; hits: number; ambiguous: number };
    bulk: { total: number; hits: number; ambiguous: number };
  };
  /** What the owner has told the assistant. The text of the latest few is included, clipped (he asked to see them). */
  notes: {
    total: number;
    standing: number;
    item: number;
    notFed: number;
    recent: { at: string; scope: string; enabled: boolean; text: string }[];
  };
  /** Median open dwell in ms by the view it was opened from, plus how many opens had a dwell. */
  openDwell: { view: string; opens: number; withDwell: number; medianMs: number | null }[];
}

interface Row {
  id: number;
  item_id: string;
  at: string;
  kind: string;
  to_value: string | null;
  source: string;
  meta: string | null;
  provider: string | null;
  ikind: string | null;
  first_seen_at: string | null;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function parseMeta(s: string | null): Record<string, any> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Counts of the owner's notes plus the latest few. Empty (not an error) for a database from before migration 12. */
function notesSummary(db: Db): HabitsReport['notes'] {
  const out: HabitsReport['notes'] = { total: 0, standing: 0, item: 0, notFed: 0, recent: [] };
  try {
    const c = db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(scope = 'standing'), 0) AS standing,
                COALESCE(SUM(scope = 'item'), 0) AS item, COALESCE(SUM(enabled = 0), 0) AS not_fed FROM notes`,
      )
      .get() as { total: number; standing: number; item: number; not_fed: number };
    out.total = c.total;
    out.standing = c.standing;
    out.item = c.item;
    out.notFed = c.not_fed;
    out.recent = (
      db.prepare('SELECT created_at, scope, enabled, text FROM notes ORDER BY id DESC LIMIT 5').all() as {
        created_at: string;
        scope: string;
        enabled: number;
        text: string;
      }[]
    ).map((r) => ({ at: r.created_at, scope: r.scope, enabled: !!r.enabled, text: r.text.slice(0, 120) }));
  } catch {
    // no notes table yet
  }
  return out;
}

/** Throws the SQLite error if item_events does not exist (databases from before migration 9). */
export function habitsReport(db: Db): HabitsReport {
  const rows = db
    .prepare(
      `SELECT e.id, e.item_id, e.at, e.kind, e.to_value, e.source, e.meta,
              i.provider, i.kind AS ikind, i.first_seen_at
         FROM item_events e LEFT JOIN items i ON i.id = e.item_id ORDER BY e.id`,
    )
    .all() as Row[];

  const mix = new Map<string, number>();
  const firstAction = new Map<string, Row>();
  /** Per item, times of user actions (state or snooze), ascending. */
  const userActs = new Map<string, number[]>();
  const wakes = new Map<string, number[]>();
  let snoozed = 0;
  const sc: HabitsReport['snoozeContext'] = {
    byLastCommenter: { mine: 0, theirs: 0, unknown: 0 },
    byComments: { '0': 0, '1-3': 0, '4+': 0, unknown: 0 },
    byItemKind: {},
  };
  const snoozeAt: { item: string; at: number }[] = [];
  // Until-activity bookkeeping: the item's latest user snooze, how its waits ended, and what he did after each fallback.
  const lastSnooze = new Map<string, { at: number; untilActivity: boolean }>();
  const byBucket: Record<string, number> = {};
  let untilActivity = 0;
  const wakeCauses = { activity: 0, fallback: 0, manual: 0 };
  const wakeMs: Record<'activity' | 'fallback' | 'manual', number[]> = { activity: [], fallback: [], manual: [] };
  const fallbackWakes: { item: string; at: number }[] = [];
  /** Per item, what each user action was (done / dismissed / resnoozed / other), for the follow-up after a fallback. */
  const nextActs = new Map<string, { at: number; what: 'done' | 'dismissed' | 'resnoozed' | 'other' }[]>();
  const dec: { at: number; meta: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const judged = new Map<
    string,
    { suggested: string; action: string; turn: string; actionId: number | null; t: number }
  >();
  /** How many items each triage/snooze action (meta.actionId) changed: more than one means it was a bulk action. */
  const actionSize = new Map<number, number>();
  /** Per item, the decision events the browser sent, to tell a bulk action from a single one when it recorded it. */
  const decisionsOf = new Map<string, { at: number; bulk: boolean }[]>();
  const dwellByView = new Map<string, { opens: number; dwell: number[] }>();
  const byInput: Record<string, number> = {};
  let rank0 = 0;
  let deeper = 0;

  for (const r of rows) {
    const t = Date.parse(r.at);
    const meta = parseMeta(r.meta);
    const key = (action: string) => `${r.provider ?? 'unknown'}\t${r.ikind ?? 'unknown'}\t${action}`;
    if ((r.kind === 'state' || r.kind === 'snooze') && r.source === 'user') {
      const isSnooze = r.kind === 'snooze';
      const action = isSnooze
        ? r.to_value
          ? 'snooze'
          : 'unsnooze'
        : r.to_value === 'done' && meta.reason === 'no_action'
          ? 'dismissed'
          : (r.to_value ?? 'unknown');
      mix.set(key(action), (mix.get(key(action)) ?? 0) + 1);
      if (!firstAction.has(r.item_id)) firstAction.set(r.item_id, r);
      if (typeof meta.actionId === 'number') actionSize.set(meta.actionId, (actionSize.get(meta.actionId) ?? 0) + 1);
      if (
        !judged.has(r.item_id) &&
        typeof meta.suggested === 'string' &&
        (action === 'done' || action === 'dismissed' || action === 'replied' || action === 'snooze')
      ) {
        judged.set(r.item_id, {
          suggested: meta.suggested,
          // A done with no reason on it was written before dismissals existed.
          action: action === 'done' && meta.reason === undefined ? LEGACY_DONE : action,
          turn: typeof meta.suggestedTurn === 'string' ? meta.suggestedTurn : 'none',
          actionId: typeof meta.actionId === 'number' ? meta.actionId : null,
          t,
        });
      }
      (userActs.get(r.item_id) ?? userActs.set(r.item_id, []).get(r.item_id)!).push(t);
      (nextActs.get(r.item_id) ?? nextActs.set(r.item_id, []).get(r.item_id)!).push({
        at: t,
        what: isSnooze
          ? r.to_value
            ? 'resnoozed'
            : 'other'
          : action === 'done'
            ? 'done'
            : action === 'dismissed'
              ? 'dismissed'
              : 'other',
      });
      if (isSnooze && !r.to_value && meta.cause === 'manual') {
        // He ended a wait for activity himself.
        const last = lastSnooze.get(r.item_id);
        if (last?.untilActivity) {
          wakeCauses.manual++;
          wakeMs.manual.push(Math.max(0, t - last.at));
        }
      }
      if (isSnooze && r.to_value) {
        snoozed++;
        snoozeAt.push({ item: r.item_id, at: t });
        const waiting = meta.untilActivity === true;
        lastSnooze.set(r.item_id, { at: t, untilActivity: waiting });
        const bucket = typeof meta.bucket === 'string' ? meta.bucket : 'none';
        byBucket[bucket] = (byBucket[bucket] ?? 0) + 1;
        if (waiting) untilActivity++;
        if (r.provider === 'github') {
          const known = typeof meta.lastCommenterIsMe === 'boolean' && 'lastCommenter' in meta;
          const who = !known ? 'unknown' : meta.lastCommenterIsMe ? 'mine' : meta.lastCommenter ? 'theirs' : 'unknown';
          sc.byLastCommenter[who]++;
          const c = meta.comments;
          sc.byComments[typeof c !== 'number' ? 'unknown' : c === 0 ? '0' : c <= 3 ? '1-3' : '4+']++;
          const k = typeof meta.itemKind === 'string' ? meta.itemKind : (r.ikind ?? 'unknown');
          sc.byItemKind[k] = (sc.byItemKind[k] ?? 0) + 1;
        }
      }
    } else if (r.kind === 'snooze' && r.source === 'auto' && !r.to_value) {
      (wakes.get(r.item_id) ?? wakes.set(r.item_id, []).get(r.item_id)!).push(t);
      const cause: unknown = meta.cause;
      if (cause === 'activity' || cause === 'fallback') {
        wakeCauses[cause]++;
        const last = lastSnooze.get(r.item_id);
        if (last) wakeMs[cause].push(Math.max(0, t - last.at));
        if (cause === 'fallback') fallbackWakes.push({ item: r.item_id, at: t });
      }
    } else if (r.kind === 'decision') {
      dec.push({ at: t, meta });
      (decisionsOf.get(r.item_id) ?? decisionsOf.set(r.item_id, []).get(r.item_id)!).push({
        at: t,
        bulk: meta.bulk === true,
      });
      if (typeof meta.rank === 'number') meta.rank === 0 ? rank0++ : deeper++;
      const input = typeof meta.input === 'string' ? meta.input : 'unknown';
      byInput[input] = (byInput[input] ?? 0) + 1;
    } else if (r.kind === 'open') {
      const view = r.to_value ?? 'unknown';
      const v = dwellByView.get(view) ?? { opens: 0, dwell: [] };
      v.opens++;
      if (typeof meta.dwellMs === 'number') v.dwell.push(meta.dwellMs);
      dwellByView.set(view, v);
    }
  }

  const actionMix = [...mix].map(([k, count]) => {
    const [provider, kind, action] = k.split('\t') as [string, string, string];
    return { provider, kind, action, count };
  });
  actionMix.sort((a, b) => a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind) || b.count - a.count);

  const ttfa = new Map<string, number[]>();
  for (const r of firstAction.values()) {
    if (!r.first_seen_at) continue;
    const dt = Date.parse(r.at) - Date.parse(r.first_seen_at);
    if (!Number.isFinite(dt)) continue;
    const p = r.provider ?? 'unknown';
    (ttfa.get(p) ?? ttfa.set(p, []).get(p)!).push(Math.max(0, dt));
  }
  const timeToFirstActionMs = [...ttfa]
    .map(([provider, xs]) => ({ provider, items: xs.length, medianMs: median(xs)! }))
    .sort((a, b) => a.provider.localeCompare(b.provider));

  // A snooze is "returned" when the item later woke; "actioned after wake" when the owner then acted on it again.
  let woken = 0;
  let actionedAfterWake = 0;
  for (const s of snoozeAt) {
    const wake = (wakes.get(s.item) ?? []).find((w) => w > s.at);
    if (wake === undefined) continue;
    woken++;
    if ((userActs.get(s.item) ?? []).some((a) => a > wake)) actionedAfterWake++;
  }

  const afterFallback = { done: 0, dismissed: 0, resnoozed: 0, other: 0, none: 0 };
  for (const w of fallbackWakes) {
    const next = (nextActs.get(w.item) ?? []).find((a) => a.at > w.at);
    afterFallback[next ? next.what : 'none']++;
  }

  let pairs = 0;
  let laterActioned = 0;
  for (const d of dec) {
    const above: unknown[] = Array.isArray(d.meta.above) ? d.meta.above : [];
    for (const id of above) {
      if (typeof id !== 'string') continue;
      pairs++;
      if ((userActs.get(id) ?? []).some((a) => a > d.at)) laterActioned++;
    }
  }

  const AGREES: Record<string, string[]> = {
    reply: ['replied'],
    act: ['done', 'snooze'],
    skip: ['dismissed'],
    spam: ['dismissed'],
  };
  type Acc = {
    total: number;
    hits: number;
    ambiguous: number;
    byAction: Record<string, number>;
    byTurn: Record<string, number>;
  };
  const hitsBy = { single: new Map<string, Acc>(), bulk: new Map<string, Acc>() };
  const summary = { single: { total: 0, hits: 0, ambiguous: 0 }, bulk: { total: 0, hits: 0, ambiguous: 0 } };
  /** The browser's decision event for the same action: close in time to the state change, whichever came first. */
  const DECISION_WINDOW_MS = 120_000;
  for (const [itemId, j] of judged) {
    const bulk =
      (j.actionId !== null && (actionSize.get(j.actionId) ?? 0) > 1) ||
      (decisionsOf.get(itemId) ?? []).some((d) => d.bulk && Math.abs(d.at - j.t) <= DECISION_WINDOW_MS);
    const side = bulk ? 'bulk' : 'single';
    const h = hitsBy[side].get(j.suggested) ?? { total: 0, hits: 0, ambiguous: 0, byAction: {}, byTurn: {} };
    h.byTurn[j.turn] = (h.byTurn[j.turn] ?? 0) + 1;
    h.byAction[j.action] = (h.byAction[j.action] ?? 0) + 1;
    hitsBy[side].set(j.suggested, h);
    // Only a reply suggestion is certainly missed by a bare done (he did not reply); the rest could have been right.
    if (j.action === LEGACY_DONE && j.suggested !== 'reply') {
      h.ambiguous++;
      summary[side].ambiguous++;
      continue;
    }
    h.total++;
    summary[side].total++;
    if (AGREES[j.suggested]?.includes(j.action)) (h.hits++, summary[side].hits++);
  }
  const listOf = (m: Map<string, Acc>): SuggestionHit[] =>
    [...m]
      .map(([suggested, h]) => ({ suggested, ...h }))
      .sort((a, b) => b.total - a.total || a.suggested.localeCompare(b.suggested));
  const suggestionHits = listOf(hitsBy.single);
  const suggestionHitsBulk = listOf(hitsBy.bulk);

  const openDwell = [...dwellByView]
    .map(([view, v]) => ({ view, opens: v.opens, withDwell: v.dwell.length, medianMs: median(v.dwell) }))
    .sort((a, b) => b.opens - a.opens);

  return {
    events: rows.length,
    notes: notesSummary(db),
    actionMix,
    timeToFirstActionMs,
    snooze: { snoozed, woken, actionedAfterWake },
    snoozeContext: sc,
    snoozeBuckets: {
      byBucket,
      untilActivity,
      wakeCauses,
      medianMsToWake: {
        activity: median(wakeMs.activity),
        fallback: median(wakeMs.fallback),
        manual: median(wakeMs.manual),
      },
      afterFallback,
    },
    decisions: { total: dec.length, withRank: rank0 + deeper, rank0, deeper, byInput },
    passedOver: { pairs, laterActioned, left: pairs - laterActioned },
    suggestionHits,
    suggestionHitsBulk,
    suggestionSummary: summary,
    openDwell,
  };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`);
export function fmtDuration(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function notesLines(r: HabitsReport): string[] {
  const n = r.notes;
  return [
    '',
    `Notes: ${n.total} (${n.standing} standing, ${n.item} about an item, ${n.notFed} not fed to the model)`,
    ...n.recent.map((x) => `  ${x.at.slice(0, 10)} ${x.scope}${x.enabled ? '' : ' (off)'}: ${x.text}`),
  ];
}

const ambiguousNote = (n: number) => (n > 0 ? `; ${n} not counted (${LEGACY_DONE})` : '');

function hitLines(out: string[], hits: SuggestionHit[]): void {
  if (hits.length === 0) out.push('    none');
  for (const h of hits) {
    const acts = Object.entries(h.byAction)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    out.push(`    suggested ${h.suggested}: ${pct(h.hits, h.total)} agreed (${acts})`);
    if (h.ambiguous > 0) {
      out.push(
        `      ${h.ambiguous} more not counted: ${LEGACY_DONE}, so not known whether he meant done or no action`,
      );
    }
    const turns = Object.entries(h.byTurn)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    if (turns && turns !== `none ${h.total}`) out.push(`      whose turn the model said: ${turns}`);
  }
}

export function formatHabits(r: HabitsReport): string {
  const out: string[] = [`Events: ${r.events}`];
  if (r.events === 0) return out.concat('Nothing recorded yet.', notesLines(r)).join('\n');
  out.push('', 'Action mix (user actions, provider / kind / action):');
  if (r.actionMix.length === 0) out.push('  none');
  for (const a of r.actionMix) out.push(`  ${a.provider} / ${a.kind} / ${a.action}: ${a.count}`);
  out.push('', 'Median time to first action (from arrival):');
  if (r.timeToFirstActionMs.length === 0) out.push('  none');
  for (const t of r.timeToFirstActionMs) out.push(`  ${t.provider}: ${fmtDuration(t.medianMs)} over ${t.items} items`);
  out.push(
    '',
    `Snoozes: ${r.snooze.snoozed}; returned (woke) ${pct(r.snooze.woken, r.snooze.snoozed)}; ` +
      `actioned again after waking ${pct(r.snooze.actionedAfterWake, r.snooze.woken)}`,
  );
  const sc = r.snoozeContext;
  const scTotal = sc.byLastCommenter.mine + sc.byLastCommenter.theirs + sc.byLastCommenter.unknown;
  out.push('', `Snooze context (GitHub snoozes: ${scTotal}):`);
  if (scTotal === 0) out.push('  none');
  else {
    const list = (o: Record<string, number>) =>
      Object.entries(o)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
    out.push(
      `  latest comment: ${list(sc.byLastCommenter)}`,
      `  comments: ${list(sc.byComments)}`,
      `  kind: ${list(sc.byItemKind) || 'none'}`,
    );
  }
  const sb = r.snoozeBuckets;
  const wc = sb.wakeCauses;
  const wcTotal = wc.activity + wc.fallback + wc.manual;
  out.push(
    '',
    `Snoozes by bucket: ${
      Object.entries(sb.byBucket)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'none'
    }; until activity: ${sb.untilActivity}`,
    `  how until-activity snoozes ended (${wcTotal}): activity ${pct(wc.activity, wcTotal)}, fallback with no activity ${pct(wc.fallback, wcTotal)}, unsnoozed by hand ${pct(wc.manual, wcTotal)}`,
    `  median time to wake: activity ${fmtDuration(sb.medianMsToWake.activity)}, fallback ${fmtDuration(sb.medianMsToWake.fallback)}, manual ${fmtDuration(sb.medianMsToWake.manual)}`,
    `  after a fallback wake he: ${Object.entries(sb.afterFallback)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}`,
  );
  const d = r.decisions;
  out.push(
    '',
    `Decisions with context: ${d.total}`,
    `  at rank 0: ${pct(d.rank0, d.withRank)}; deeper: ${pct(d.deeper, d.withRank)}`,
    `  input: ${
      Object.entries(d.byInput)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'none'
    }`,
    `  items passed over: ${r.passedOver.pairs}; later actioned ${pct(r.passedOver.laterActioned, r.passedOver.pairs)}; ` +
      `left ${pct(r.passedOver.left, r.passedOver.pairs)}`,
    '',
    'Suggestion hit rate (first action on items that had a suggestion):',
    `  single decisions: ${r.suggestionSummary.single.total}, agreed ${pct(r.suggestionSummary.single.hits, r.suggestionSummary.single.total)}` +
      ambiguousNote(r.suggestionSummary.single.ambiguous),
    `  bulk: ${r.suggestionSummary.bulk.total}, agreed ${pct(r.suggestionSummary.bulk.hits, r.suggestionSummary.bulk.total)} (shown separately; not a per-item judgement)` +
      ambiguousNote(r.suggestionSummary.bulk.ambiguous),
    '  one at a time:',
  );
  hitLines(out, r.suggestionHits);
  if (r.suggestionHitsBulk.length > 0) {
    out.push('  bulk actions:');
    hitLines(out, r.suggestionHitsBulk);
  }
  out.push(...notesLines(r));
  out.push('', 'Open dwell by view:');
  if (r.openDwell.length === 0) out.push('  none');
  for (const o of r.openDwell)
    out.push(`  ${o.view}: median ${fmtDuration(o.medianMs)} (${o.withDwell} timed of ${o.opens} opens)`);
  return out.join('\n');
}
