import type { RpgSheet, RpgNews } from '../../shared/types.js';
import {
  ACHIEVEMENTS,
  BOSSES,
  LOOT,
  LOOT_LOG_EVERY,
  RPG_SEEN_VERSION,
  describeTier,
  levelForXp,
  lootLogItem,
  roman,
  tierKey,
  titleFor,
  xpForLevel,
  type AchievementId,
  type BossId,
  type LootId,
} from '../../shared/rpg.js';
import type { RpgReader, RpgSeen } from '../contracts.js';
import type { Db } from './db.js';
import { REPLAY_ITEMS_WHERE, replayInbox, type ReplayState } from './replay.js';
import {
  DAY_MS,
  actionIdOf,
  bulkIndex,
  checkTimeZone,
  dayCounter,
  loadEvents,
  ms,
  parseMeta,
  resolutionOf,
  undoIndex,
  weekday,
  type HistEvent,
  type Resolution,
} from './history.js';

// The day helpers moved to history.ts (shared with Insights); re-exported for existing callers.
export { checkTimeZone, dayCounter, weekday } from './history.js';

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
/** Thresholds of the one-off silly achievements (docs/RPG.md §5). */
export const SILLY = { answerReplies: 42, leetXp: 1337, groundhogDones: 3, necromancyDays: 3 * 365 } as const;
/** Each boss's own ladder of achievements (the Elder Wyrm's is Archaeologist, which counts items rather than falls). */
const BOSS_LADDER: Partial<Record<BossId, AchievementId>> = {
  ancient_one: 'ancient_bane',
  hydra: 'hydra_hunter',
  lich: 'lich_bane',
};
const NEWCOMERS = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN']);

type Res = Resolution;
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
  title: string | null;
}

type Ev = HistEvent;

interface ItemState extends ReplayState {
  id: string;
  provider: string;
  kind: string;
  firstSeen: number;
  /** When the thing itself was written or opened (its age), falling back to arrival. */
  occurred: number;
  newcomer: boolean;
  comments: number;
  thread: string;
  title: string;
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
  /** Times marked done (not undone), and whether the owner has undone anything on it (Groundhog Day, Off-by-One). */
  dones: number;
  undone: boolean;
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

const resolution = resolutionOf;

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
  /** Called on each good day with the run's length so far (for Keeper of the Flame and Steady Hand). */
  onGood?: (run: number, day: number) => void;
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
      p.onGood?.(run.good, d);
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

  const events = loadEvents(db, ['state', 'snooze', 'reply', 'undo']);

  /* ---- pass 1: what was undone, and which actions were bulk (shared with Insights and habits: history.ts) ---- */
  const undos = undoIndex(events);
  const undoActions = undos.actions;
  const cancelled = undos.cancelled;
  // Adventure mode judges bulk by action id alone (a resolving action that changed more than one item).
  const isBulk = bulkIndex(events, { decisions: false }).isBulk;

  /* ---- items: everything with history, plus whatever sits in the inbox now ---- */
  const itemRows = db
    .prepare(
      `SELECT i.id, i.provider, i.kind, i.state, i.snoozed_until, i.first_seen_at, i.occurred_at, i.data, c.thread_id,
              i.title
         FROM items i LEFT JOIN comments c ON c.id = i.id
        WHERE ${REPLAY_ITEMS_WHERE}`,
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
      title: r.title ?? '',
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
      dones: 0,
      undone: false,
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
      title: '',
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
      dones: 0,
      undone: false,
    };
    items.set(id, s);
    return s;
  };

  /* ---- replay state ---- */
  let count = 0;
  let peak = 0;
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
  /** Every reply action, counted once each (the app-posted reply writes two events for one action). */
  const replyActions = new Set<string>();
  const polyglotDays = new Set<number>();
  const ytReplied = new Set<string>();
  const newcomersReplied = new Set<string>();
  const audited = new Set<string>();
  const todosDone = new Set<string>();
  /** Items dealt with (done or reply, not a dismissal, not bulk), in all and by what they were. */
  const dealtItems = new Set<string>();
  const prsDealt = new Set<string>();
  const issuesDealt = new Set<string>();
  const old90 = new Set<string>();
  const old365 = new Set<string>();
  const snoozedOften = new Set<string>();
  const mimics = new Set<string>();
  const ballads = new Set<string>();
  let monks = 0;
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
  /**
   * Achievements are ladders (a one-off is a ladder of one tier at 1): per achievement, the count so far (never
   * lowered: what was earned stays earned) and the day each tier was reached.
   */
  const ladders = new Map<AchievementId, { def: (typeof ACHIEVEMENTS)[number]; n: number; days: number[] }>(
    ACHIEVEMENTS.map((a) => [a.id, { def: a, n: 0, days: [] }]),
  );
  const reachDay = (id: AchievementId, value: number, day: number) => {
    const l = ladders.get(id)!;
    if (value > l.n) l.n = value;
    while (l.days.length < l.def.tiers.length && l.n >= l.def.tiers[l.days.length]!) l.days.push(day);
  };
  const reach = (id: AchievementId, value: number, t: number) => reachDay(id, value, days.day(t));
  const earn = (id: AchievementId, t: number) => reach(id, 1, t);
  const earnDay = (id: AchievementId, day: number) => reachDay(id, 1, day);
  const bosses = new Map<BossId, { n: number; day: number }>();
  const slay = (id: BossId, t: number) => {
    const b = bosses.get(id);
    if (b) b.n++;
    else bosses.set(id, { n: 1, day: days.day(t) });
    const ladder = BOSS_LADDER[id];
    if (ladder) reach(ladder, bosses.get(id)!.n, t);
  };
  let hadBacklog30 = false;
  let hadBacklog365 = false;

  /** The replay moved an item into or out of the inbox (history.ts keeps the count; the heap and peak are ours). */
  const onVisibility = (it: ItemState, t: number, c: number) => {
    count = c;
    if (it.visible) heap.push({ occ: it.occurred, id: it.id, ver: it.ver });
    if (count > peak) peak = count;
    if (peak >= HALF_LIFE_MIN_PEAK && count * 2 <= peak) earn('half_life', t);
  };

  /** The state between a and b did not change: what does it say about those days? */
  const advance = (a: number, b: number) => {
    if (b <= a) return;
    const cset = count === 0 ? zeroCamp : workCamp;
    for (let d = camp(a), to = camp(b); d <= to; d++) cset.add(d);
    if (count === 0) {
      const from = days.day(a);
      const to = days.day(b);
      for (let d = from; d <= to; d++) {
        if (zeroDays.has(d)) continue;
        zeroDays.add(d);
        earnDay('inbox_zero', d);
        reachDay('zero_hero', zeroDays.size, d);
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
        reach('ascendant', maxLevel, e.t);
      }
      if (xp >= SILLY.leetXp) earn('leet', e.t);
    }

    const day = days.day(e.t);
    if (res === 'reply') {
      earn('hello_world', e.t);
      if (it.provider === 'youtube') replyDaysYt.add(day);
      if (it.provider === 'github') replyDaysGh.add(day);
      if (replyDaysYt.has(day) && replyDaysGh.has(day) && !polyglotDays.has(day)) {
        polyglotDays.add(day);
        reach('polyglot', polyglotDays.size, e.t);
      }
      // The app-posted reply writes both a state and a reply event for one action: count it once.
      const a = actionIdOf(e);
      const key = a !== null ? `${it.id}:a${a}` : `e${e.id}`;
      const set = repliesPerThread.get(it.thread) ?? repliesPerThread.set(it.thread, new Set()).get(it.thread)!;
      set.add(key);
      reach('long_conversation', set.size, e.t);
      replyActions.add(key);
      reach('town_crier', replyActions.size, e.t);
      if (replyActions.size >= SILLY.answerReplies) earn('the_answer', e.t);
      if (it.provider === 'youtube' && !bulk) {
        ytReplied.add(it.id);
        reach('fan_mail', ytReplied.size, e.t);
      }
      if (it.newcomer && !bulk) {
        newcomersReplied.add(it.id);
        lootTimes.quill = newcomersReplied.size;
        reach('welcome_wagon', newcomersReplied.size, e.t);
      }
      if (afterActivity) reach('monk', ++monks, e.t);
      if (it.provider === 'youtube' && age >= 30 * DAY_MS) {
        lootTimes.lute++;
        ballads.add(it.id);
        reach('minstrel', ballads.size, e.t);
      }
    }
    if ((res === 'done' || res === 'legacy') && it.kind === 'todo') {
      todosDone.add(it.id);
      reach('rubber_duck', todosDone.size, e.t);
      if (/duck/i.test(it.title)) earn('quack', e.t);
    }
    if (!dealt) return;
    markGood(e.t);
    dealtItems.add(it.id);
    reach('veteran', dealtItems.size, e.t);
    if (it.provider === 'github' && it.kind === 'pr') reach('reviewer', prsDealt.add(it.id).size, e.t);
    if (it.provider === 'github' && it.kind === 'issue') reach('bug_wrangler', issuesDealt.add(it.id).size, e.t);
    if (it.undone) earn('off_by_one', e.t);
    if (res === 'done' && ++it.dones >= SILLY.groundhogDones) earn('groundhog', e.t);
    const key = days.key(day);
    if (key.endsWith('-10-31')) earn('spooky', e.t);
    if (key.endsWith('-02-29')) earn('leap_day', e.t);
    if (age >= 90 * DAY_MS) {
      lanternDays.add(day);
      lanterns++;
      reach('necromancer', old90.add(it.id).size, e.t);
    }
    if (age >= 365 * DAY_MS) {
      reach('archaeologist', old365.add(it.id).size, e.t);
      slay('elder_wyrm', e.t);
    }
    if (age >= SILLY.necromancyDays * DAY_MS) earn('necromancy', e.t);
    if (it.provider === 'github' && it.comments >= 20) slay('hydra', e.t);
    if (it.fallbacks >= 2) slay('lich', e.t);
    if (it.visible && count >= ANCIENT_ONE_MIN_INBOX) {
      const oldest = heap.peek(live);
      if (oldest && oldest.occ >= it.occurred) slay('ancient_one', e.t);
    }
    if (afterFallback) {
      audited.add(it.id);
      reach('auditor', audited.size, e.t);
    }
    if (res !== 'reply') {
      if (it.snoozes >= 3) {
        lootTimes.hourglass++;
        reach('second_wind', snoozedOften.add(it.id).size, e.t);
      }
      if (afterActivity?.trigger === 'merged' && afterActivity.bucket === 'waiting_on_merge') {
        lootTimes.tooth++;
        reach('mimic_hunter', mimics.add(it.id).size, e.t);
      }
    }
  };

  replayInbox(items, events, nowMs, {
    gap: advance,
    visibility: onVisibility,
    event(e, known) {
      const it = known ?? ghost(e.item);
      const gone = cancelled(e);
      const userAct =
        (e.source === 'user' && (e.kind === 'state' || e.kind === 'snooze' || e.kind === 'undo')) || e.kind === 'reply';
      if (userAct) activeDays.add(days.day(e.t));

      if (!gone) {
        if (e.kind === 'undo' && e.source === 'user') {
          undoCount = undoActions.size > 0 ? Math.min(undoActions.size, undoCount + 1) : undoCount;
          lootTimes.ring = undoCount;
          reach('ctrl_z_adept', undoCount, e.t);
          it.undone = true;
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
    },
  });

  /* ---- after the replay: weekends off, the campfire, today's decoration ---- */
  if (activeDays.size > 0) {
    const first = Math.min(...activeDays);
    let weekends = 0;
    for (let d = first + 1; d + 1 < today; d++) {
      if (weekday(d) === 6 && !activeDays.has(d) && !activeDays.has(d + 1)) reachDay('rest', ++weekends, d + 1);
    }
  }
  let goodDays = 0;
  const fire = campfire({
    good: (d) => goodCamp.has(d) || goodPrevCamp.has(d) || (workCamp.has(d) && zeroCamp.has(d)),
    work: (d) => workCamp.has(d),
    days: [...goodCamp, ...goodPrevCamp, ...workCamp],
    today: camp(nowMs),
    decidedThrough: camp(nowMs - CAMPFIRE.graceMs) - 1,
    // Campfire days share the day numbering of `days` (shifted by the rollover), so they date tiers directly.
    onGood: (run, d) => {
      reachDay('keeper', run, d);
      reachDay('steady_hand', ++goodDays, d);
    },
  });
  // Trophy Case counts every other tier, reached on the day the n-th of them was.
  const tierDays = [...ladders.values()].filter((l) => l.def.id !== 'trophy_case').flatMap((l) => l.days);
  tierDays.sort((a, b) => a - b);
  tierDays.forEach((d, i) => reachDay('trophy_case', i + 1, d));

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
      const l = ladders.get(a.id)!;
      const tier = l.days.length;
      const shown = !a.hidden || tier > 0;
      const done = tier >= a.tiers.length;
      const next = a.tiers[tier];
      return {
        id: a.id,
        name: shown ? a.name : null,
        description: shown ? describeTier(a, done ? tier : tier + 1) : null,
        hidden: a.hidden,
        earned: tier > 0,
        tier,
        tiers: a.tiers.length,
        earnedOn: tier > 0 ? days.key(l.days[tier - 1]!) : null,
        progress: shown && a.tiers.length > 1 && next !== undefined ? { n: Math.min(next, l.n), of: next } : null,
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
 *
 * A `seen` from an older rules version (before the slower curve and the ladders) is migrated: it gets one quiet
 * "rebalanced" line with the level as it now is, everything earned so far is marked seen, and the stored level is set
 * to the new (usually lower) one, so the next level-up is announced normally and nothing earlier is replayed.
 */
export function planClaim(sheet: RpgSheet, seen: RpgSeen | null): { news: RpgNews; seen: RpgSeen } {
  const earnedAch = sheet.achievements.filter((a) => a.earned);
  const earnedKeys = earnedAch.flatMap((a) => Array.from({ length: a.tier }, (_, i) => tierKey(a.id, i + 1)));
  const fallen = sheet.bosses.filter((b) => b.defeated > 0);
  const lootDef = new Map(LOOT.map((l) => [l.id, l]));
  const loudLoot = sheet.loot
    .filter((l) => l.earned && (LOUD_LOOT as string[]).includes(l.id))
    .map((l) => ({ key: l.id, id: l.id }));
  if (sheet.today.lantern) loudLoot.push({ key: `lantern:${sheet.day}`, id: 'lantern' });
  const notice = sheet.campfire.notice;
  const noticeKey = notice ? `camp:${notice.kind}:${notice.day}` : null;
  const news: RpgNews = {
    arrive: null,
    rebalanced: null,
    levelUp: null,
    achievements: [],
    bosses: [],
    loot: [],
    campfire: null,
  };
  const everything = (level: number, old: RpgSeen | null): RpgSeen => ({
    v: RPG_SEEN_VERSION,
    level,
    achievements: earnedKeys,
    bosses: [...new Set([...(old?.bosses ?? []), ...fallen.map((b) => b.id)])],
    loot: [...new Set([...(old?.loot ?? []), ...loudLoot.map((l) => l.key), ...(noticeKey ? [noticeKey] : [])])],
  });
  if (!seen) {
    news.arrive = { level: sheet.level, title: sheet.levelTitle };
    return { news, seen: everything(sheet.level, null) };
  }
  if ((seen.v ?? 1) < RPG_SEEN_VERSION) {
    news.rebalanced = { level: sheet.level, title: sheet.levelTitle };
    return { news, seen: everything(sheet.level, seen) };
  }
  if (sheet.level > seen.level) news.levelUp = { from: seen.level, to: sheet.level, title: sheet.levelTitle };
  for (const a of earnedAch) {
    // Only the highest new tier is worth a word; the ones below it are marked seen with it.
    const fresh = Array.from({ length: a.tier }, (_, i) => tierKey(a.id, i + 1)).some(
      (k) => !seen.achievements.includes(k),
    );
    if (fresh) news.achievements.push({ id: a.id, name: achievementName(a), tier: a.tier });
  }
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
      v: RPG_SEEN_VERSION,
      level: Math.max(seen.level, sheet.level),
      achievements: [...new Set([...seen.achievements, ...earnedKeys])],
      bosses: [...new Set([...seen.bosses, ...news.bosses.map((b) => b.id)])],
      loot: [...new Set(loot)],
    },
  };
}

/** "Rubber Duck III" for a ladder, the plain name for a one-off. */
function achievementName(a: RpgSheet['achievements'][number]): string {
  return a.tiers > 1 ? `${a.name} ${roman(a.tier)}` : a.name!;
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
