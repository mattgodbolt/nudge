import type { Db } from './db.js';
import { DAY_MS, HOUR_MS, loadEvents, localClock, ms, type HistEvent } from './history.js';

/**
 * The inbox replay (docs/RPG.md §5, shared with Insights' "backlog over time"): arrivals (first_seen_at, in the state
 * the first state event's `from` says, else the current one), state, snooze and undo events, and the moments snoozes ran
 * out, in time order, keeping a running count of the inbox as the Inbox view defines it (state `inbox`, not snoozed).
 * History from before item_events existed (migration 9) is approximate. Only reads.
 */

/** What the replay needs of an item; callers extend it with their own bookkeeping. */
export interface ReplayState {
  id: string;
  firstSeen: number;
  /** False for an item that takes no part (deleted since, say): its events still reach the hooks. */
  replay: boolean;
  initialState: string;
  initialSnooze: number | null;
  state: string;
  snoozedUntil: number | null;
  arrived: boolean;
  visible: boolean;
  /** Bumped each time the item becomes visible again, so a stale entry for an earlier visit can be told apart. */
  ver: number;
}

export interface ReplayHooks<T extends ReplayState> {
  /** Nothing changed between a and b (b > a), with `count` in the inbox; only once the first item has arrived. */
  gap?(a: number, b: number, count: number): void;
  /** An event, before the replay applies it; `it` is the item, if it is known. */
  event?(e: HistEvent, it: T | undefined): void;
  /** The item came into, or left, the inbox at t; `count` is the new total. */
  visibility?(it: T, t: number, count: number): void;
}

/** The fields of a ReplayState for an item row, before the replay fills in how it arrived. */
export function replayState(id: string, firstSeen: number, state: string, snoozedUntil: number | null): ReplayState {
  return {
    id,
    firstSeen,
    replay: true,
    initialState: state,
    initialSnooze: snoozedUntil,
    state,
    snoozedUntil: null,
    arrived: false,
    visible: false,
    ver: 0,
  };
}

/** Run the replay over `items` (the ones to replay, keyed by id) and the history, up to now. */
export function replayInbox<T extends ReplayState>(
  items: Map<string, T>,
  events: readonly HistEvent[],
  nowMs: number,
  hooks: ReplayHooks<T> = {},
): void {
  // What each item was when it arrived: the first state event's `from` says (the arrival itself is not recorded), and
  // likewise the first snooze event's `from` for a snooze already in force. Without either, its current values.
  const firstStateSeen = new Set<string>();
  const firstSnoozeSeen = new Set<string>();
  const firstEventAt = new Map<string, number>();
  for (const e of [...events].sort((x, y) => x.t - y.t || x.id - y.id)) {
    const it = items.get(e.item);
    if (!it?.replay) continue;
    if (!firstEventAt.has(e.item)) firstEventAt.set(e.item, e.t);
    const isState = e.kind === 'state' || (e.kind === 'undo' && e.meta.original !== 'snooze');
    const isSnooze = e.kind === 'snooze' || (e.kind === 'undo' && e.meta.original === 'snooze');
    if (isState && !firstStateSeen.has(e.item)) {
      firstStateSeen.add(e.item);
      if (e.from) it.initialState = e.from;
    }
    if (isSnooze && !firstSnoozeSeen.has(e.item)) {
      firstSnoozeSeen.add(e.item);
      it.initialSnooze = ms(e.from);
    }
  }

  /* ---- the timeline: arrivals, events, and the moments snoozes ran out ---- */
  type Entry =
    | { t: number; ord: 0; type: 'arrive'; it: T }
    | { t: number; ord: 1; type: 'event'; e: HistEvent }
    | { t: number; ord: 2; type: 'expire'; it: T };
  const timeline: Entry[] = [];
  for (const it of items.values()) {
    if (!it.replay) continue;
    const t = Math.min(it.firstSeen, firstEventAt.get(it.id) ?? Infinity);
    timeline.push({ t, ord: 0, type: 'arrive', it });
    if (it.initialSnooze !== null && it.initialSnooze <= nowMs)
      timeline.push({ t: it.initialSnooze, ord: 2, type: 'expire', it });
  }
  for (const e of events) {
    timeline.push({ t: e.t, ord: 1, type: 'event', e });
    const it = items.get(e.item);
    const snoozeTo = e.kind === 'snooze' || (e.kind === 'undo' && e.meta.original === 'snooze') ? ms(e.to) : null;
    if (it?.replay && snoozeTo !== null && snoozeTo <= nowMs)
      timeline.push({ t: snoozeTo, ord: 2, type: 'expire', it });
  }
  timeline.sort(
    (x, y) => x.t - y.t || x.ord - y.ord || (x.type === 'event' && y.type === 'event' ? x.e.id - y.e.id : 0),
  );

  let count = 0;
  let started = false;
  const updateVis = (it: T, t: number) => {
    const vis = it.arrived && it.state === 'inbox' && (it.snoozedUntil === null || it.snoozedUntil <= t);
    if (vis === it.visible) return;
    it.visible = vis;
    count += vis ? 1 : -1;
    if (vis) it.ver++;
    hooks.visibility?.(it, t, count);
  };
  const gap = (a: number, b: number) => {
    if (started && b > a) hooks.gap?.(a, b, count);
  };

  let prevT: number | null = null;
  for (const en of timeline) {
    if (prevT !== null) gap(prevT, en.t);
    prevT = prevT === null ? en.t : Math.max(prevT, en.t);
    if (en.type === 'arrive') {
      const it = en.it;
      it.arrived = true;
      it.state = it.initialState;
      it.snoozedUntil = it.initialSnooze;
      started = true;
      updateVis(it, en.t);
      continue;
    }
    if (en.type === 'expire') {
      updateVis(en.it, en.t);
      continue;
    }
    const e = en.e;
    hooks.event?.(e, items.get(e.item));
    // The replay follows what actually happened, undone or not (the undo is its own event).
    const it = items.get(e.item);
    if (it?.replay) {
      if (e.kind === 'state' && e.to) it.state = e.to;
      else if (e.kind === 'snooze') it.snoozedUntil = ms(e.to);
      else if (e.kind === 'undo') {
        if (e.meta.original === 'snooze') it.snoozedUntil = ms(e.to);
        else if (e.to) it.state = e.to;
      }
      updateVis(it, e.t);
    }
  }
  if (prevT !== null) gap(prevT, Math.max(prevT, nowMs));
}

/** The items the replay covers: everything with history, plus whatever sits in the inbox now. */
export const REPLAY_ITEMS_WHERE = "i.state = 'inbox' OR i.id IN (SELECT item_id FROM item_events)";

/**
 * The inbox count at the end of each local day from `from` to `to` (day numbers as localClock; today ends now), for
 * the days after the first arrival the history knows of. Read only.
 */
export function inboxCountByDay(
  db: Db,
  opts: { now: number; tz: string; from: number; to: number },
): { day: number; count: number }[] {
  const rows = db
    .prepare(`SELECT i.id, i.state, i.snoozed_until, i.first_seen_at FROM items i WHERE ${REPLAY_ITEMS_WHERE}`)
    .all() as { id: string; state: string; snoozed_until: string | null; first_seen_at: string }[];
  const items = new Map<string, ReplayState>();
  for (const r of rows)
    items.set(r.id, replayState(r.id, ms(r.first_seen_at) ?? opts.now, r.state, ms(r.snoozed_until)));
  const events = loadEvents(db, ['state', 'snooze', 'undo']);
  const clock = localClock(opts.tz);
  // The count after each change, in time order; the end of a day is read off the last change before it.
  const changes: { t: number; count: number }[] = [];
  let first: number | null = null;
  replayInbox(items, events, opts.now, {
    visibility: (_it, t, count) => {
      first ??= t;
      changes.push({ t, count });
    },
    gap: (a) => {
      first ??= a;
    },
  });
  if (first === null) return [];
  const firstDay = Math.max(opts.from, clock.day(first));
  const out: { day: number; count: number }[] = [];
  let i = 0;
  let count = 0;
  for (let d = firstDay; d <= opts.to; d++) {
    // The first moment of the next local day (memoised quarter hours, so DST days are found exactly).
    let end = (d + 1) * DAY_MS - 15 * HOUR_MS;
    while (clock.day(end) <= d) end += 900_000;
    end = Math.min(end, opts.now + 1);
    while (i < changes.length && changes[i]!.t < end) count = changes[i++]!.count;
    out.push({ day: d, count });
  }
  return out;
}
