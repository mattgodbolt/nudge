import type { Db } from './db.js';

/**
 * Shared readings of the item_events history, used by the habits report, Adventure mode (rpg.ts) and Insights
 * (insights.ts) so all three agree on what a meta blob says, what an undo cancels, what counts as a bulk action, what
 * a suggestion "hit" is, and which local day or hour a moment falls in. Everything here only reads.
 */

/**
 * What a user state event to 'done' was. Events written since dismissals existed carry meta.reason ('done' or
 * 'no_action'); a bare done from before that could have meant either, so it is kept apart rather than guessed at.
 */
export const LEGACY_DONE = 'done (before dismissals existed)';

/** Which first actions agree with each suggestion: reply by replied; act by done or snooze; skip and spam by dismissed. */
export const AGREES: Readonly<Record<string, readonly string[]>> = {
  reply: ['replied'],
  act: ['done', 'snooze'],
  skip: ['dismissed'],
  spam: ['dismissed'],
};

/** The browser's decision event for the same action: close in time to the state change, whichever came first. */
export const DECISION_WINDOW_MS = 120_000;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Meta = Record<string, any>;

/** A meta (or data) JSON column as an object; anything unreadable or not an object is `{}`. */
export function parseMeta(s: string | null | undefined): Meta {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** An ISO time as epoch ms, or null when missing or unreadable. */
export const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

export const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Linear-interpolated quantile (q in 0..1) of the values; null for none. median(xs) === quantile(xs, 0.5). */
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * Calendar days in a time zone, as integers (days since 1970-01-01 in that zone), so day arithmetic is plain
 * subtraction and DST never makes a day 23 or 25 hours long. Every zone's offset is a multiple of 15 minutes, so the
 * answer is memoised per quarter hour.
 */
export function dayCounter(tz: string): { day(t: number): number; key(day: number): string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const memo = new Map<number, number>();
  return {
    day(t: number): number {
      const q = Math.floor(t / 900_000);
      let d = memo.get(q);
      if (d === undefined) {
        const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
        d = Math.round(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS);
        memo.set(q, d);
      }
      return d;
    },
    key: (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10),
  };
}

/** 0 = Sunday ... 6 = Saturday, for a day number from dayCounter (1970-01-01 was a Thursday). */
export const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;

/** Throws RangeError when the runtime does not know the zone. */
export function checkTimeZone(tz: string): void {
  new Intl.DateTimeFormat('en', { timeZone: tz });
}

/**
 * Local calendar day and hour (0-23) of a moment in a zone, from one formatter, memoised per quarter hour. On a
 * spring-forward day the skipped hour simply never occurs; on a fall-back day the repeated hour occurs twice (both
 * land in the same hour bucket), so hour counts follow the wall clock the owner saw.
 */
export function localClock(tz: string): { day(t: number): number; hour(t: number): number; key(day: number): string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const memo = new Map<number, { day: number; hour: number }>();
  const at = (t: number) => {
    const q = Math.floor(t / 900_000);
    let v = memo.get(q);
    if (v === undefined) {
      const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
      v = {
        day: Math.round(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS),
        hour: Number(p.hour) % 24,
      };
      memo.set(q, v);
    }
    return v;
  };
  return {
    day: (t) => at(t).day,
    hour: (t) => at(t).hour,
    key: (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10),
  };
}

/** One item_events row, parsed. */
export interface HistEvent {
  id: number;
  item: string;
  t: number;
  kind: string;
  from: string | null;
  to: string | null;
  source: string;
  meta: Meta;
}

interface EventRow {
  id: number;
  item_id: string;
  at: string;
  kind: string;
  from_value: string | null;
  to_value: string | null;
  source: string;
  meta: string | null;
}

/** The history of the given kinds, oldest first by id; rows with an unreadable time are skipped. */
export function loadEvents(db: Db, kinds: readonly string[]): HistEvent[] {
  const rows = db
    .prepare(
      `SELECT id, item_id, at, kind, from_value, to_value, source, meta FROM item_events
        WHERE kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY id`,
    )
    .all(...kinds) as EventRow[];
  const out: HistEvent[] = [];
  for (const r of rows) {
    const t = ms(r.at);
    if (t === null) continue;
    out.push({
      id: r.id,
      item: r.item_id,
      t,
      kind: r.kind,
      from: r.from_value,
      to: r.to_value,
      source: r.source,
      meta: parseMeta(r.meta),
    });
  }
  return out;
}

export const actionIdOf = (e: { meta: Meta }): number | null =>
  typeof e.meta.actionId === 'number' ? e.meta.actionId : null;

/**
 * What the owner's undos cancelled. An undo cancels its original event, matched by `meta.originalEventId`, and also
 * every user event of the same item carrying the same `meta.actionId` (which covers rows backfilled before item_events
 * existed, and the extra `reply` event an app-posted reply writes). `actions` is the set of distinct undone actions.
 */
export function undoIndex(events: readonly HistEvent[]): { cancelled(e: HistEvent): boolean; actions: Set<string> } {
  const cancelledIds = new Set<number>();
  const undone = new Set<string>(); // item \0 actionId
  const actions = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'undo' || e.source !== 'user') continue;
    if (typeof e.meta.originalEventId === 'number') cancelledIds.add(e.meta.originalEventId);
    const a = actionIdOf(e);
    if (a !== null) undone.add(`${e.item}\0${a}`);
    actions.add(a !== null ? `a${a}` : `e${e.id}`);
  }
  return {
    actions,
    cancelled(e) {
      if (cancelledIds.has(e.id)) return true;
      if (e.source !== 'user' || e.kind === 'undo') return false;
      const a = actionIdOf(e);
      return a !== null && undone.has(`${e.item}\0${a}`);
    },
  };
}

/**
 * Bulk actions: items changed by one triage/snooze action share `meta.actionId` on their user state/snooze rows, so an
 * action id seen on more than one item was a bulk action. With `decisions`, a browser decision row flagged `bulk` for
 * the same item within DECISION_WINDOW_MS also makes it bulk (a bulk of items that were mostly already done changes
 * only one). Adventure mode leaves decisions out; the habits report and Insights use them.
 */
export function bulkIndex(
  events: readonly HistEvent[],
  opts: { decisions: boolean },
): { isBulk(e: HistEvent): boolean; itemsOf(actionId: number): number } {
  const itemsBy = new Map<number, Set<string>>();
  const bulkDecisions = new Map<string, number[]>();
  for (const e of events) {
    if (e.source !== 'user') continue;
    if (e.kind === 'state' || e.kind === 'snooze') {
      const a = actionIdOf(e);
      if (a !== null) (itemsBy.get(a) ?? itemsBy.set(a, new Set()).get(a)!).add(e.item);
    } else if (opts.decisions && e.kind === 'decision' && e.meta.bulk === true) {
      (bulkDecisions.get(e.item) ?? bulkDecisions.set(e.item, []).get(e.item)!).push(e.t);
    }
  }
  const itemsOf = (a: number) => itemsBy.get(a)?.size ?? 0;
  return {
    itemsOf,
    isBulk(e) {
      const a = actionIdOf(e);
      if (a !== null && itemsOf(a) > 1) return true;
      return (bulkDecisions.get(e.item) ?? []).some((t) => Math.abs(t - e.t) <= DECISION_WINDOW_MS);
    },
  };
}

/**
 * How the owner resolved an item with this event, if it is a resolution of theirs: a reply (sent from Nudge, the
 * copy-and-open hand-off, or seen by GitHub sync from one of their accounts), a done, a dismissal, or a bare legacy done.
 */
export type Resolution = 'reply' | 'done' | 'legacy' | 'dismiss';
export function resolutionOf(e: HistEvent): Resolution | null {
  if (e.kind === 'reply' && (e.source === 'user' || e.source === 'sync')) return 'reply';
  if (e.kind !== 'state' || e.source !== 'user') return null;
  if (e.to === 'replied') return 'reply';
  if (e.to !== 'done') return null;
  if (e.meta.reason === 'no_action') return 'dismiss';
  if (e.meta.reason === 'done') return 'done';
  return 'legacy';
}
