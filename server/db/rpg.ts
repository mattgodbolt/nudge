import type { RpgSheet, RpgNews } from '../../shared/types.js';
import {
  ACHIEVEMENTS,
  BOSSES,
  LOOT,
  LOOT_LOG_EVERY,
  levelForXp,
  lootLogItem,
  titleFor,
  xpForLevel,
  type AchievementId,
  type BossId,
  type LootId,
} from '../../shared/rpg.js';
import type { RpgReader, RpgSeen } from '../contracts.js';
import type { Db } from './db.js';

/**
 * Adventure mode (docs/RPG.md): a level, titles, trophies and loot, worked out from the history in item_events plus a
 * few facts from items (provider, kind, arrival and creation times, the GitHub author relation and comment count).
 *
 * This module only reads. It prepares SELECTs and nothing else, and a test runs it against a database opened read-only.
 * Nothing in the inbox, keys, snooze, suggestion or push code may import it (server/rpg-boundary.test.ts), so it cannot
 * change how the app works: it is decoration computed after the fact.
 *
 * XP: each item pays once, for the best of the owner's resolutions of it that were not undone (an undo cancels its
 * original event by originalEventId, or by actionId for rows backfilled from before item_events existed). Snoozes and
 * anything done by the app or by the remote service pay nothing.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** Bonus sizes and thresholds, named once so the tests and the doc can point at them. */
export const XP = {
  reply: 10,
  done: 8,
  todo: 5,
  legacy: 4,
  dismiss: 1,
  bulk: 1,
  patiencePerWeek: 1,
  patienceCap: 20,
  audit: 5,
  welcome: 5,
} as const;
/** An inbox must hold at least this many for its oldest item to count as the Ancient One. */
export const ANCIENT_ONE_MIN_INBOX = 5;
/** Half-Life needs a peak at least this big, so a 2 → 1 inbox earns nothing. */
export const HALF_LIFE_MIN_PEAK = 10;
const NEWCOMERS = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN']);

type Res = 'reply' | 'done' | 'legacy' | 'dismiss';

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
interface ItemRow {
  id: string;
  provider: string;
  kind: string;
  state: string;
  snoozed_until: string | null;
  first_seen_at: string;
  occurred_at: string;
  data: string | null;
  thread_id: string | null;
}

interface Ev {
  id: number;
  item: string;
  t: number;
  kind: string;
  from: string | null;
  to: string | null;
  source: string;
  meta: Record<string, unknown>;
}

interface ItemState {
  id: string;
  provider: string;
  kind: string;
  firstSeen: number;
  /** When the thing itself was written or opened (its age), falling back to arrival. */
  occurred: number;
  newcomer: boolean;
  comments: number;
  thread: string;
  /** Replay. */
  replay: boolean;
  initialState: string;
  initialSnooze: number | null;
  state: string;
  snoozedUntil: number | null;
  arrived: boolean;
  visible: boolean;
  ver: number;
  /** Bookkeeping for bonuses, bosses and loot. */
  best: number;
  bestRes: Res | null;
  snoozes: number;
  fallbacks: number;
  pendingFallback: boolean;
  pendingActivity: { trigger: unknown; bucket: unknown } | null;
}

function parseMeta(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

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

/** Min-heap of inbox items by age, for "is this the oldest one" and "how old is the oldest" during the replay. */
class AgeHeap {
  private a: { occ: number; id: string; ver: number }[] = [];
  push(x: { occ: number; id: string; ver: number }) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.occ <= a[i]!.occ) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  /** The oldest live entry; stale ones (no longer visible, or pushed for an earlier visit) are dropped on the way. */
  peek(live: (x: { id: string; ver: number }) => boolean): { occ: number; id: string } | null {
    const a = this.a;
    while (a.length > 0 && !live(a[0]!)) {
      const last = a.pop()!;
      if (a.length === 0) break;
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.occ < a[m]!.occ) m = l;
        if (r < a.length && a[r]!.occ < a[m]!.occ) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return a[0] ?? null;
  }
}

/** The resolution an event is, if it is one the owner made. */
function resolution(e: Ev): Res | null {
  if (e.kind === 'reply' && (e.source === 'user' || e.source === 'sync')) return 'reply';
  if (e.kind !== 'state' || e.source !== 'user') return null;
  if (e.to === 'replied') return 'reply';
  if (e.to !== 'done') return null;
  if (e.meta.reason === 'no_action') return 'dismiss';
  if (e.meta.reason === 'done') return 'done';
  return 'legacy';
}
const actionIdOf = (e: Ev): number | null => (typeof e.meta.actionId === 'number' ? e.meta.actionId : null);

/** The campfire's rules, named once (docs/RPG.md, "The campfire"). */
export const CAMPFIRE = {
  /** Local hour at which a campfire day ends. */
  rolloverHours: 4,
  /** A day is only judged missed this long after its rollover, so a late night or a time-zone hop never counts. */
  graceMs: 6 * 3_600_000,
  /** Misses forgiven per run (a "rest day"), and the good days after a miss that earn it back. */
  rests: 1,
  restoreAfterGood: 5,
  /** The chip shows the flame from this many good days in the current run. */
  flameAt: 3,
} as const;

/** Day numbers (as dayCounter) for a zone, with the campfire's 04:00 rollover. */
export function campDays(tz: string): (t: number) => number {
  const c = dayCounter(tz);
  return (t) => c.day(t - CAMPFIRE.rolloverHours * 3_600_000);
}

export interface CampfireState {
  /** Good days in the current run (0 when none is lit). */
  current: number;
  longest: number;
  /** A rest day has covered a miss in this run and has not been earned back yet. */
  restUsed: boolean;
  /** Good days still needed to earn the rest day back (0 when it is unused). */
  goodToRestore: number;
  /** The latest miss worth a word: covered by a rest day (run still going), or the one that put the fire out. */
  notice: { kind: 'forgiven' | 'out'; day: number } | null;
}

/**
 * Walk the campfire days in order. A good day adds to the run (and lights one). A day with work in the inbox but no
 * good action is a miss, once it is decided (well over): the first miss in a run is covered by a rest day, a second
 * one while the rest day is spent puts the fire out. The rest day comes back after `restoreAfterGood` good days. Days
 * with nothing to do are neither good nor missed: they neither break nor advance anything.
 */
export function campfire(p: {
  good: (d: number) => boolean;
  work: (d: number) => boolean;
  days: number[];
  today: number;
  decidedThrough: number;
}): CampfireState {
  const out: CampfireState = { current: 0, longest: 0, restUsed: false, goodToRestore: 0, notice: null };
  if (p.days.length === 0) return out;
  let first = Infinity;
  for (const d of p.days) if (d < first) first = d;
  let run: { good: number; restsLeft: number; sinceMiss: number; missDay: number | null } | null = null;
  let lastOut: number | null = null;
  for (let d = first; d <= p.today; d++) {
    if (p.good(d)) {
      run ??= { good: 0, restsLeft: CAMPFIRE.rests, sinceMiss: 0, missDay: null };
      run.good++;
      out.longest = Math.max(out.longest, run.good);
      if (run.restsLeft < CAMPFIRE.rests && ++run.sinceMiss >= CAMPFIRE.restoreAfterGood) {
        run.restsLeft = CAMPFIRE.rests;
        run.missDay = null;
      }
    } else if (run && p.work(d) && d <= p.decidedThrough) {
      if (run.restsLeft > 0) {
        run.restsLeft--;
        run.sinceMiss = 0;
        run.missDay = d;
      } else {
        lastOut = d;
        run = null;
      }
    }
  }
  if (run) {
    out.current = run.good;
    out.restUsed = run.restsLeft < CAMPFIRE.rests;
    out.goodToRestore = out.restUsed ? CAMPFIRE.restoreAfterGood - run.sinceMiss : 0;
    if (run.missDay !== null) out.notice = { kind: 'forgiven', day: run.missDay };
  } else if (lastOut !== null) out.notice = { kind: 'out', day: lastOut };
  return out;
}

export interface SheetOptions {
  now: Date;
  /** IANA zone for days (the browser's). */
  tz: string;
  /**
   * The zone the browser used before, when it has changed: a campfire day then counts as good if it was good in either
   * zone, so travelling never turns a day of work into a "missed" one.
   */
  prevTz?: string | null;
  /** The earned title the owner picked (a level), or null. */
  chosenTitle?: number | null;
}

/** Work out the whole character sheet. Read only. Throws RangeError for an unknown time zone. */
export function rpgSheet(db: Db, opts: SheetOptions): RpgSheet {
  const nowMs = opts.now.getTime();
  const days = dayCounter(opts.tz);
  const today = days.day(nowMs);
  // Campfire days roll over at 04:00 local, so late-night triage counts for the day before.
  const camp = campDays(opts.tz);
  const prevCamp = opts.prevTz && opts.prevTz !== opts.tz ? campDays(opts.prevTz) : null;

  const rows = db
    .prepare(
      `SELECT id, item_id, at, kind, from_value, to_value, source, meta FROM item_events
        WHERE kind IN ('state', 'snooze', 'reply', 'undo') ORDER BY id`,
    )
    .all() as EventRow[];
  const events: Ev[] = [];
  for (const r of rows) {
    const t = ms(r.at);
    if (t === null) continue;
    events.push({
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

  /* ---- pass 1: what was undone, and which actions were bulk ---- */
  const cancelledIds = new Set<number>();
  const undone = new Set<string>(); // item \0 actionId
  const undoActions = new Set<string>();
  const resolvedBy = new Map<number, Set<string>>(); // actionId -> items it resolved
  for (const e of events) {
    if (e.kind === 'undo' && e.source === 'user') {
      if (typeof e.meta.originalEventId === 'number') cancelledIds.add(e.meta.originalEventId);
      const a = actionIdOf(e);
      if (a !== null) undone.add(`${e.item}\0${a}`);
      undoActions.add(a !== null ? `a${a}` : `e${e.id}`);
    }
    const res = resolution(e);
    const a = actionIdOf(e);
    if (res && a !== null && e.kind === 'state') {
      (resolvedBy.get(a) ?? resolvedBy.set(a, new Set()).get(a)!).add(e.item);
    }
  }
  const cancelled = (e: Ev): boolean => {
    if (cancelledIds.has(e.id)) return true;
    if (e.source !== 'user' || e.kind === 'undo') return false;
    const a = actionIdOf(e);
    return a !== null && undone.has(`${e.item}\0${a}`);
  };
  const isBulk = (e: Ev): boolean => {
    const a = actionIdOf(e);
    return a !== null && (resolvedBy.get(a)?.size ?? 0) > 1;
  };

  /* ---- items: everything with history, plus whatever sits in the inbox now ---- */
  const itemRows = db
    .prepare(
      `SELECT i.id, i.provider, i.kind, i.state, i.snoozed_until, i.first_seen_at, i.occurred_at, i.data, c.thread_id
         FROM items i LEFT JOIN comments c ON c.id = i.id
        WHERE i.state = 'inbox' OR i.id IN (SELECT item_id FROM item_events)`,
    )
    .all() as ItemRow[];
  const items = new Map<string, ItemState>();
  for (const r of itemRows) {
    const data = parseMeta(r.data);
    const firstSeen = ms(r.first_seen_at) ?? nowMs;
    items.set(r.id, {
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      firstSeen,
      occurred: ms(r.occurred_at) ?? firstSeen,
      newcomer: r.provider === 'github' && typeof data.association === 'string' && NEWCOMERS.has(data.association),
      comments: typeof data.comments === 'number' ? data.comments : 0,
      thread: r.provider === 'youtube' && r.thread_id ? `yt:${r.thread_id}` : r.id,
      replay: true,
      initialState: r.state,
      initialSnooze: ms(r.snoozed_until),
      state: r.state,
      snoozedUntil: null,
      arrived: false,
      visible: false,
      ver: 0,
      best: 0,
      bestRes: null,
      snoozes: 0,
      fallbacks: 0,
      pendingFallback: false,
      pendingActivity: null,
    });
  }
  /** Items deleted since (a purged source) still keep what they paid; they just take no part in the replay. */
  const ghost = (id: string): ItemState => {
    const s: ItemState = {
      id,
      provider: 'unknown',
      kind: 'unknown',
      firstSeen: nowMs,
      occurred: nowMs,
      newcomer: false,
      comments: 0,
      thread: id,
      replay: false,
      initialState: 'archived',
      initialSnooze: null,
      state: 'archived',
      snoozedUntil: null,
      arrived: false,
      visible: false,
      ver: 0,
      best: 0,
      bestRes: null,
      snoozes: 0,
      fallbacks: 0,
      pendingFallback: false,
      pendingActivity: null,
    };
    items.set(id, s);
    return s;
  };

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
    | { t: number; ord: 0; type: 'arrive'; it: ItemState }
    | { t: number; ord: 1; type: 'event'; e: Ev }
    | { t: number; ord: 2; type: 'expire'; it: ItemState };
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

  /* ---- replay state ---- */
  let count = 0;
  let peak = 0;
  let started = false;
  const heap = new AgeHeap();
  const live = (x: { id: string; ver: number }) => {
    const it = items.get(x.id);
    return !!it && it.visible && it.ver === x.ver;
  };

  let xp = 0;
  let maxLevel = 1;
  let payouts = 0;
  const lootLog: { name: string; t: number }[] = [];
  const levelUpDays = new Set<number>();
  let levelUps = 0;

  const zeroDays = new Set<number>();
  /** Campfire days (04:00 rollover): good under this zone, good under the previous one, with work, with a zero. */
  const goodCamp = new Set<number>();
  const goodPrevCamp = new Set<number>();
  const workCamp = new Set<number>();
  const zeroCamp = new Set<number>();
  const markGood = (t: number) => {
    goodCamp.add(camp(t));
    if (prevCamp) goodPrevCamp.add(prevCamp(t));
  };
  const activeDays = new Set<number>();
  const lanternDays = new Set<number>();
  let lanterns = 0;
  const replyDaysYt = new Set<number>();
  const replyDaysGh = new Set<number>();
  const repliesPerThread = new Map<string, Set<string>>();
  const newcomersReplied = new Set<string>();
  const audited = new Set<string>();
  const todosDone = new Set<string>();
  let undoCount = 0;
  const lootTimes: Record<LootId, number> = {
    cloak: 0,
    lantern: 0,
    hat: 0,
    quill: 0,
    ring: 0,
    phosphor: 0,
    amber: 0,
    hourglass: 0,
    tooth: 0,
    lute: 0,
  };
  const earned = new Map<AchievementId, number>(); // id -> day
  const earn = (id: AchievementId, t: number) => {
    if (!earned.has(id)) earned.set(id, days.day(t));
  };
  const earnDay = (id: AchievementId, day: number) => {
    if (!earned.has(id)) earned.set(id, day);
  };
  const bosses = new Map<BossId, { n: number; day: number }>();
  const slay = (id: BossId, t: number) => {
    const b = bosses.get(id);
    if (b) b.n++;
    else bosses.set(id, { n: 1, day: days.day(t) });
  };
  let hadBacklog30 = false;
  let hadBacklog365 = false;

  const updateVis = (it: ItemState, t: number) => {
    const vis = it.arrived && it.state === 'inbox' && (it.snoozedUntil === null || it.snoozedUntil <= t);
    if (vis === it.visible) return;
    it.visible = vis;
    count += vis ? 1 : -1;
    if (vis) {
      it.ver++;
      heap.push({ occ: it.occurred, id: it.id, ver: it.ver });
    }
    if (count > peak) peak = count;
    if (peak >= HALF_LIFE_MIN_PEAK && count * 2 <= peak) earn('half_life', t);
  };

  /** The state between a and b did not change: what does it say about those days? */
  const advance = (a: number, b: number) => {
    if (!started || b <= a) return;
    const cset = count === 0 ? zeroCamp : workCamp;
    for (let d = camp(a), to = camp(b); d <= to; d++) cset.add(d);
    if (count === 0) {
      const from = days.day(a);
      const to = days.day(b);
      for (let d = from; d <= to; d++) {
        if (zeroDays.has(d)) continue;
        zeroDays.add(d);
        earnDay('inbox_zero', d);
        if (zeroDays.size >= 7) earnDay('zero_hero', d);
      }
    }
    const oldest = count > 0 ? heap.peek(live) : null;
    if (hadBacklog30 && (!oldest || a - oldest.occ < 30 * DAY_MS)) earn('backlog_breaker', a);
    if (hadBacklog365 && (!oldest || a - oldest.occ < 365 * DAY_MS)) earn('ancient_evil', a);
    if (oldest && b - oldest.occ >= 30 * DAY_MS) hadBacklog30 = true;
    if (oldest && b - oldest.occ >= 365 * DAY_MS) hadBacklog365 = true;
  };

  const pay = (it: ItemState, e: Ev, res: Res, afterFallback: boolean, afterActivity: ItemState['pendingActivity']) => {
    const bulk = isBulk(e);
    const age = e.t - it.occurred;
    const dealt = !bulk && res !== 'dismiss';
    let value: number;
    if (bulk) value = XP.bulk;
    else if (res === 'dismiss') value = XP.dismiss;
    else if (res === 'legacy') value = XP.legacy;
    else {
      value = res === 'reply' ? XP.reply : it.kind === 'todo' ? XP.todo : XP.done;
      if (it.replay) {
        const weeks = Math.floor(Math.max(0, e.t - it.firstSeen) / WEEK_MS);
        value += Math.min(XP.patienceCap, weeks * XP.patiencePerWeek);
      }
      if (afterFallback) value += XP.audit;
      if (res === 'reply' && it.newcomer) value += XP.welcome;
    }
    if (value > it.best) {
      if (it.best === 0) {
        payouts++;
        earn('first_blood', e.t);
        if (payouts % LOOT_LOG_EVERY === 0) lootLog.push({ name: lootLogItem(it.id), t: e.t });
      }
      xp += value - it.best;
      it.best = value;
      it.bestRes = res;
      const lvl = levelForXp(xp);
      if (lvl > maxLevel) {
        levelUps += lvl - maxLevel;
        maxLevel = lvl;
        levelUpDays.add(days.day(e.t));
      }
    }

    const day = days.day(e.t);
    if (res === 'reply') {
      earn('hello_world', e.t);
      if (it.provider === 'youtube') replyDaysYt.add(day);
      if (it.provider === 'github') replyDaysGh.add(day);
      if (replyDaysYt.has(day) && replyDaysGh.has(day)) earn('polyglot', e.t);
      // The app-posted reply writes both a state and a reply event for one action: count it once.
      const a = actionIdOf(e);
      const set = repliesPerThread.get(it.thread) ?? repliesPerThread.set(it.thread, new Set()).get(it.thread)!;
      set.add(a !== null ? `${it.id}:a${a}` : `e${e.id}`);
      if (set.size >= 5) earn('long_conversation', e.t);
      if (it.newcomer && !bulk) {
        newcomersReplied.add(it.id);
        lootTimes.quill = newcomersReplied.size;
        if (newcomersReplied.size >= 10) earn('welcome_wagon', e.t);
      }
      if (afterActivity) earn('monk', e.t);
      if (it.provider === 'youtube' && age >= 30 * DAY_MS) lootTimes.lute++;
    }
    if ((res === 'done' || res === 'legacy') && it.kind === 'todo') {
      todosDone.add(it.id);
      if (todosDone.size >= 50) earn('rubber_duck', e.t);
    }
    if (!dealt) return;
    markGood(e.t);
    if (age >= 90 * DAY_MS) {
      lanternDays.add(day);
      lanterns++;
    }
    if (age >= 365 * DAY_MS) {
      earn('archaeologist', e.t);
      slay('elder_wyrm', e.t);
    }
    if (it.provider === 'github' && it.comments >= 20) slay('hydra', e.t);
    if (it.fallbacks >= 2) slay('lich', e.t);
    if (it.visible && count >= ANCIENT_ONE_MIN_INBOX) {
      const oldest = heap.peek(live);
      if (oldest && oldest.occ >= it.occurred) slay('ancient_one', e.t);
    }
    if (afterFallback) {
      audited.add(it.id);
      if (audited.size >= 10) earn('auditor', e.t);
    }
    if (res !== 'reply') {
      if (it.snoozes >= 3) lootTimes.hourglass++;
      if (afterActivity?.trigger === 'merged' && afterActivity.bucket === 'waiting_on_merge') lootTimes.tooth++;
    }
  };

  let prevT: number | null = null;
  for (const en of timeline) {
    if (prevT !== null) advance(prevT, en.t);
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
    const it = items.get(e.item) ?? ghost(e.item);
    const gone = cancelled(e);
    const userAct =
      (e.source === 'user' && (e.kind === 'state' || e.kind === 'snooze' || e.kind === 'undo')) || e.kind === 'reply';
    if (userAct) activeDays.add(days.day(e.t));

    if (!gone) {
      if (e.kind === 'undo' && e.source === 'user') {
        undoCount = undoActions.size > 0 ? Math.min(undoActions.size, undoCount + 1) : undoCount;
        lootTimes.ring = undoCount;
        if (undoCount >= 10) earn('ctrl_z_adept', e.t);
      } else if (e.kind === 'snooze' && e.source === 'auto' && !e.to) {
        if (e.meta.cause === 'fallback') {
          it.fallbacks++;
          it.pendingFallback = true;
          it.pendingActivity = null;
        } else if (e.meta.cause === 'activity') {
          it.pendingActivity = { trigger: e.meta.trigger, bucket: e.meta.bucket };
          it.pendingFallback = false;
        }
      } else if ((e.source === 'user' && (e.kind === 'state' || e.kind === 'snooze')) || e.kind === 'reply') {
        // The owner's next move after something came back: what the audit, Monk and Mimic rules look at.
        const afterFallback = it.pendingFallback;
        const afterActivity = it.pendingActivity;
        it.pendingFallback = false;
        it.pendingActivity = null;
        if (e.kind === 'snooze' && e.to) it.snoozes++;
        const res = resolution(e);
        if (res) pay(it, e, res, afterFallback, afterActivity);
      }
    }

    // The replay follows what actually happened, undone or not (the undo is its own event).
    if (it.replay) {
      if (e.kind === 'state' && e.to) it.state = e.to;
      else if (e.kind === 'snooze') it.snoozedUntil = ms(e.to);
      else if (e.kind === 'undo') {
        if (e.meta.original === 'snooze') it.snoozedUntil = ms(e.to);
        else if (e.to) it.state = e.to;
      }
      updateVis(it, e.t);
    }
  }
  if (prevT !== null) advance(prevT, Math.max(prevT, nowMs));

  /* ---- after the replay: weekends off, the campfire, today's decoration ---- */
  if (activeDays.size > 0) {
    const first = Math.min(...activeDays);
    for (let d = first + 1; d + 1 < today; d++) {
      if (weekday(d) === 6 && !activeDays.has(d) && !activeDays.has(d + 1)) {
        earnDay('rest', d + 1);
        break;
      }
    }
  }
  const fire = campfire({
    good: (d) => goodCamp.has(d) || goodPrevCamp.has(d) || (workCamp.has(d) && zeroCamp.has(d)),
    work: (d) => workCamp.has(d),
    days: [...goodCamp, ...goodPrevCamp, ...workCamp],
    today: camp(nowMs),
    decidedThrough: camp(nowMs - CAMPFIRE.graceMs) - 1,
  });

  const level = levelForXp(xp);
  lootTimes.cloak = zeroDays.size;
  lootTimes.lantern = lanterns;
  lootTimes.hat = levelUps;
  lootTimes.phosphor = level >= 10 ? 1 : 0;
  lootTimes.amber = level >= 15 ? 1 : 0;

  const tally = { payouts, replies: 0, dones: 0, dismissals: 0 };
  for (const it of items.values()) {
    if (it.bestRes === 'reply') tally.replies++;
    else if (it.bestRes === 'done' || it.bestRes === 'legacy') tally.dones++;
    else if (it.bestRes === 'dismiss') tally.dismissals++;
  }
  const progressOf = (id: AchievementId): number => {
    switch (id) {
      case 'zero_hero':
        return zeroDays.size;
      case 'welcome_wagon':
        return newcomersReplied.size;
      case 'auditor':
        return audited.size;
      case 'rubber_duck':
        return todosDone.size;
      case 'ctrl_z_adept':
        return undoCount;
      default:
        return 0;
    }
  };
  const chosen = opts.chosenTitle ?? null;
  const levelTitle = titleFor(level);
  return {
    day: days.key(today),
    xp,
    level,
    levelTitle,
    title: chosen !== null && chosen >= 1 && chosen <= level ? titleFor(chosen) : levelTitle,
    levelXp: xpForLevel(level),
    nextLevelXp: xpForLevel(level + 1),
    today: {
      cloak: zeroDays.has(today),
      lantern: lanternDays.has(today),
      hat: levelUpDays.has(today),
      flame: fire.current >= CAMPFIRE.flameAt,
    },
    campfire: { ...fire, notice: fire.notice ? { kind: fire.notice.kind, day: days.key(fire.notice.day) } : null },
    accent: level >= 15 ? 'amber' : level >= 10 ? 'phosphor' : 'default',
    achievements: ACHIEVEMENTS.map((a) => {
      const day = earned.get(a.id);
      const shown = !a.hidden || day !== undefined;
      return {
        id: a.id,
        name: shown ? a.name : null,
        description: shown ? a.description : null,
        hidden: a.hidden,
        earned: day !== undefined,
        earnedOn: day !== undefined ? days.key(day) : null,
        progress: a.of && shown ? { n: Math.min(a.of, progressOf(a.id)), of: a.of } : null,
      };
    }),
    bosses: BOSSES.map((b) => {
      const s = bosses.get(b.id);
      return { ...b, defeated: s?.n ?? 0, firstOn: s ? days.key(s.day) : null };
    }),
    loot: LOOT.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      earned: lootTimes[l.id] > 0,
      times: lootTimes[l.id],
    })),
    lootLog: lootLog
      .slice(-30)
      .reverse()
      .map((x) => ({ name: x.name, on: days.key(days.day(x.t)) })),
    titles: Array.from({ length: level }, (_, i) => ({ level: i + 1, title: titleFor(i + 1) })),
    chosenTitle: chosen,
    tally,
  };
}

/** Loot that announces itself with a toast line (the rest are quiet badges in the Hall). */
const LOUD_LOOT: LootId[] = ['ring', 'tooth', 'lute'];
const LANTERN_KEYS_KEPT = 7;

/**
 * What is new on the sheet since `seen`, and what `seen` becomes. Pure: the caller stores the result. A null `seen`
 * (never claimed since the mode was switched on) gives only the arrival line, and marks everything earned so far as
 * seen, so nothing from the past is replayed. A level lost to an undo is not announced again when it comes back.
 */
export function planClaim(sheet: RpgSheet, seen: RpgSeen | null): { news: RpgNews; seen: RpgSeen } {
  const earnedAch = sheet.achievements.filter((a) => a.earned);
  const fallen = sheet.bosses.filter((b) => b.defeated > 0);
  const lootDef = new Map(LOOT.map((l) => [l.id, l]));
  const loudLoot = sheet.loot
    .filter((l) => l.earned && (LOUD_LOOT as string[]).includes(l.id))
    .map((l) => ({ key: l.id, id: l.id }));
  if (sheet.today.lantern) loudLoot.push({ key: `lantern:${sheet.day}`, id: 'lantern' });
  const notice = sheet.campfire.notice;
  const noticeKey = notice ? `camp:${notice.kind}:${notice.day}` : null;
  const news: RpgNews = { arrive: null, levelUp: null, achievements: [], bosses: [], loot: [], campfire: null };
  if (!seen) {
    news.arrive = { level: sheet.level, title: sheet.levelTitle };
    return {
      news,
      seen: {
        level: sheet.level,
        achievements: earnedAch.map((a) => a.id),
        bosses: fallen.map((b) => b.id),
        loot: [...loudLoot.map((l) => l.key), ...(noticeKey ? [noticeKey] : [])],
      },
    };
  }
  if (sheet.level > seen.level) news.levelUp = { from: seen.level, to: sheet.level, title: sheet.levelTitle };
  for (const a of earnedAch) if (!seen.achievements.includes(a.id)) news.achievements.push({ id: a.id, name: a.name! });
  for (const b of fallen) if (!seen.bosses.includes(b.id)) news.bosses.push({ id: b.id, name: b.name, line: b.line });
  for (const l of loudLoot) {
    if (seen.loot.includes(l.key)) continue;
    const def = lootDef.get(l.id as LootId)!;
    news.loot.push({ id: l.id, name: def.name, line: def.line ?? def.name });
  }
  if (notice && noticeKey && !seen.loot.includes(noticeKey)) news.campfire = notice;
  const keys = [
    ...seen.loot,
    ...loudLoot.filter((l) => !seen.loot.includes(l.key)).map((l) => l.key),
    ...(news.campfire ? [noticeKey!] : []),
  ];
  // Dated keys only need to outlive their day; keep the latest few of each so the row stays small.
  const dated = (prefix: string) => keys.filter((k) => k.startsWith(prefix)).sort();
  const latest = (xs: string[]) => xs.slice(Math.max(0, xs.length - LANTERN_KEYS_KEPT));
  const loot = [
    ...keys.filter((k) => !k.startsWith('lantern:') && !k.startsWith('camp:')),
    ...latest(dated('lantern:')),
    ...latest(dated('camp:')),
  ];
  return {
    news,
    seen: {
      level: Math.max(seen.level, sheet.level),
      achievements: [...new Set([...seen.achievements, ...news.achievements.map((a) => a.id)])],
      bosses: [...new Set([...seen.bosses, ...news.bosses.map((b) => b.id)])],
      loot: [...new Set(loot)],
    },
  };
}

/**
 * The reader the routes use: the sheet, cached until the history changes (or a minute passes, since "today" and
 * snoozes running out move on with the clock even when nothing is written).
 */
export function createRpgReader(db: Db, clock: () => Date = () => new Date()): RpgReader {
  const stamp = db.prepare(
    `SELECT (SELECT MAX(id) FROM item_events) AS e, (SELECT COUNT(*) FROM items) AS n,
            (SELECT MAX(first_seen_at) FROM items) AS f, (SELECT MAX(state_changed_at) FROM items) AS s`,
  );
  let cache: { key: string; sheet: RpgSheet } | null = null;
  return {
    sheet(tz, chosenTitle, prevTz = null) {
      checkTimeZone(tz);
      if (prevTz) checkTimeZone(prevTz);
      const now = clock();
      const s = stamp.get() as Record<string, unknown>;
      const key = JSON.stringify([s.e, s.n, s.f, s.s, tz, prevTz, chosenTitle, Math.floor(now.getTime() / 60_000)]);
      if (cache?.key === key) return cache.sheet;
      const sheet = rpgSheet(db, { now, tz, prevTz, chosenTitle });
      cache = { key, sheet };
      return sheet;
    },
  };
}
