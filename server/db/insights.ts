import type { Statement } from 'better-sqlite3';
import {
  AGE_BANDS,
  CONFIDENCES,
  FIRST_ACTIONS,
  SIZE_BANDS,
  SUGGESTED,
  TURNS,
  insightsSentence,
  type AgeBand,
  type InsightCard,
  type Insights,
  type InsightsRange,
  type ItemRef,
  type Outcome,
  type RankedRow,
  type SizeBand,
  type WeekGrid,
} from '../../shared/insights.js';
import type { Db } from './db.js';
import {
  AGREES,
  DAY_MS,
  HOUR_MS,
  actionIdOf,
  bulkIndex,
  checkTimeZone,
  loadEvents,
  localClock,
  median,
  ms,
  parseMeta,
  quantile,
  resolutionOf,
  undoIndex,
  weekday,
  type HistEvent,
} from './history.js';
import { inboxCountByDay } from './replay.js';

/**
 * Insights (docs/INSIGHTS.md): what the history says about when things arrive, what the owner does with them and how
 * good the suggestion model is. Read only: this module prepares SELECTs and nothing else (a test runs it against a
 * database opened read-only, and server/insights-boundary.test.ts checks its source and who imports it).
 *
 * Who is in it: items that reached the inbox, i.e. not the owner's own, not muted and not archived (`world` also leaves
 * out todos, which the owner writes, for everything about arrivals, sources, responses and predictions; their actions on
 * todos still count in the rhythm). An "arrival" is an item Nudge saw within LIVE_LAG_MS of it being written (so an
 * import or backfill is not a burst of arrivals), plus an upstream re-arrival (new activity or a reopen). Actions are
 * the owner's own state/snooze/reply events minus anything an undo cancelled; a bulk action counts once, at its time, in the
 * rhythm and is left out of every rate and of the suggestion accuracy. No card shows a number under its minimum.
 */

/** The least each card needs before it shows a figure (docs/INSIGHTS.md §3). */
export const MIN = {
  arrivals: 50,
  actions: 50,
  firstResponseRow: 10,
  outcomes: 20,
  rateRow: 10,
  snoozes: 10,
  undos: 1,
  agreement: 30,
  confusion: 30,
  repos: 5,
  videos: 5,
  channelRow: 5,
  channels: 2,
  regularRow: 3,
  bigThread: 10,
  mix: 10,
  backlog: 1,
  overTimeDays: 14,
  quietestHourDays: 7,
} as const;

/** Seen this soon after it was written: a live arrival rather than an import or a backfill. */
export const LIVE_LAG_MS = 48 * HOUR_MS;
const RANGE_DAYS: Record<Exclude<InsightsRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };
const TOP_RANKED = 8;
const TOP_REGULARS = 5;
const TOP_THREADS = 5;
const MIX_PARTS = 6;

export interface InsightsOptions {
  range: InsightsRange;
  tz: string;
  now: Date;
}

interface ItemRow {
  id: string;
  provider: string;
  kind: string;
  container_key: string | null;
  container_title: string | null;
  title: string | null;
  author: string | null;
  is_own: number;
  muted: number;
  state: string;
  occurred_at: string;
  first_seen_at: string;
  data: string | null;
  snoozed_until: string | null;
  snoozed_at: string | null;
  snooze_bucket: string | null;
  woke_at: string | null;
  replies: number | null;
  thread_id: string | null;
  channel_title: string | null;
  video_title: string | null;
}

interface Item {
  row: ItemRow;
  id: string;
  provider: string;
  kind: string;
  /** Reached the inbox: not the owner's own, not muted, not archived. */
  inUniverse: boolean;
  /** inUniverse and not a todo: something the world sent. */
  world: boolean;
  firstSeen: number;
  occurred: number;
  live: boolean;
  /** Current thread size: a YouTube thread's reply count, a GitHub item's comment count; null for todos. */
  size: number | null;
  bot: boolean;
  events: HistEvent[];
}

const card = <T>(n: number, min: number, make: () => T): InsightCard<T> => ({ n, min, data: n >= min ? make() : null });
const nullCard = <T>(min: number): InsightCard<T> => ({ n: 0, min, data: null });
const rate = (hits: number, n: number, min: number): number | null => (n >= min && n > 0 ? hits / n : null);
const grid = (): number[][] => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
const inc = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

function weekGrid(counts: number[][], weekdays: number[]): WeekGrid {
  const perDay = counts.map((row, wd) => row.map((c) => (weekdays[wd]! > 0 ? c / weekdays[wd]! : 0)));
  let peak: WeekGrid['peak'] = null;
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const c = counts[wd]![h]!;
      if (c > 0 && (!peak || perDay[wd]![h]! > peak.perDay))
        peak = { weekday: wd, hour: h, perDay: perDay[wd]![h]!, count: c };
    }
  }
  return { counts, perDay, weekdays, peak };
}

function ranked(m: Map<string, number>, top: number): { rows: RankedRow[]; other: number } {
  const all = [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  return { rows: all.slice(0, top), other: all.slice(top).reduce((a, r) => a + r.n, 0) };
}

const sizeBand = (n: number): SizeBand => (n === 0 ? '0' : n <= 3 ? '1-3' : n <= 10 ? '4-10' : '11+');
const ageBand = (ageMs: number): AgeBand =>
  ageMs < DAY_MS
    ? '<1d'
    : ageMs < 7 * DAY_MS
      ? '1-7d'
      : ageMs < 28 * DAY_MS
        ? '1-4w'
        : ageMs < 90 * DAY_MS
          ? '1-3m'
          : '3m+';

/** A name for an item that is never its body: a GitHub title, "author on video", or a todo's title. */
function labelOf(r: ItemRow): string {
  if (r.provider === 'youtube') {
    const video = r.container_title ?? r.video_title;
    return video ? `${r.author ?? 'Someone'} on “${video}”` : (r.author ?? 'A comment');
  }
  if (r.provider === 'github') return r.container_key ? `${r.container_key}: ${r.title ?? ''}`.trim() : (r.title ?? '');
  return r.title ?? 'An item';
}
const refOf = (it: Item): ItemRef => ({ itemId: it.id, label: labelOf(it.row), provider: it.provider });

function myAccounts(db: Db): Set<string> {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'github'").get() as { value: string } | undefined;
    const accounts = parseMeta(r?.value).myAccounts;
    return new Set(
      Array.isArray(accounts) ? accounts.filter((a) => typeof a === 'string').map((a) => a.toLowerCase()) : [],
    );
  } catch {
    return new Set();
  }
}

/** Today's suggestion category per item: the approximation for actions recorded before the category was. */
function currentCategories(db: Db): Map<string, string> {
  try {
    const rows = db.prepare('SELECT item_id, category FROM suggestions WHERE injection_attempt = 0').all() as {
      item_id: string;
      category: string;
    }[];
    return new Map(rows.map((r) => [r.item_id, r.category]));
  } catch {
    return new Map(); // no suggestions table yet
  }
}

function loadItems(db: Db): ItemRow[] {
  return db
    .prepare(
      `SELECT i.id, i.provider, i.kind, i.container_key, i.container_title, i.title, i.author, i.is_own, i.muted, i.state,
              i.occurred_at, i.first_seen_at, i.data, i.snoozed_until, i.snoozed_at, i.snooze_bucket, i.woke_at,
              t.total_reply_count AS replies, t.id AS thread_id, v.channel_title, v.title AS video_title
         FROM items i
         LEFT JOIN comments c ON c.id = i.id
         LEFT JOIN threads t ON t.id = c.thread_id
         LEFT JOIN videos v ON i.provider = 'youtube' AND v.id = i.container_key`,
    )
    .all() as ItemRow[];
}

/** Every card empty: for a database too old to read (before the snooze columns), and as the shape tests compare to. */
export function emptyInsights(opts: InsightsOptions): Insights {
  return {
    range: opts.range,
    tz: opts.tz,
    generatedAt: opts.now.toISOString(),
    from: null,
    days: 0,
    sentence: insightsSentence({
      range: opts.range,
      actions: 0,
      dealt: 0,
      dealtBy: [],
      replied: 0,
      hourlyActions: null,
      loudest: null,
      agreement: null,
    }),
    empty: true,
    rhythm: {
      arrivals: nullCard(MIN.arrivals),
      actions: nullCard(MIN.actions),
      hourly: nullCard(MIN.arrivals),
      firstResponse: nullCard(MIN.firstResponseRow),
    },
    responses: {
      outcomes: nullCard(MIN.outcomes),
      replyBySource: nullCard(MIN.rateRow),
      replyBySize: nullCard(MIN.rateRow),
      ageWhenAnswered: nullCard(MIN.rateRow),
      snoozes: nullCard(MIN.snoozes),
      undos: nullCard(MIN.undos),
    },
    predictions: {
      agreement: nullCard(MIN.agreement),
      bySuggestion: nullCard(MIN.rateRow),
      calibration: nullCard(MIN.rateRow),
      confusion: nullCard(MIN.confusion),
      categories: nullCard(MIN.rateRow),
      turns: nullCard(MIN.rateRow),
    },
    sources: {
      repos: nullCard(MIN.repos),
      videos: nullCard(MIN.videos),
      channels: nullCard(MIN.channels),
      regulars: nullCard(MIN.regularRow),
      threads: nullCard(MIN.bigThread),
      mix: nullCard(MIN.mix),
    },
    backlog: {
      inboxAge: nullCard(MIN.backlog),
      elder: nullCard(MIN.backlog),
      snoozedNow: nullCard(MIN.backlog),
      overTime: nullCard(MIN.overTimeDays),
    },
    extras: {
      busiestDay: nullCard(1),
      quietestHour: nullCard(MIN.arrivals),
      biggestCleared: nullCard(1),
      polyglot: nullCard(1),
    },
  };
}

type Judged = {
  suggested: string;
  action: (typeof FIRST_ACTIONS)[number];
  confidence: unknown;
  turn: unknown;
  category: string | null;
  approxCategory: boolean;
};
type Tally = Map<string, { n: number; hits: number }>;
const splitKey = (k: string): { provider: string; kind: string } => {
  const [provider, kind] = k.split('\t') as [string, string];
  return { provider, kind };
};

/** What every section reads: the items with their events, the clock, the range in whole local days, and the filters. */
interface Ctx {
  db: Db;
  opts: InsightsOptions;
  nowMs: number;
  clock: ReturnType<typeof localClock>;
  today: number;
  items: Map<string, Item>;
  events: HistEvent[];
  undos: ReturnType<typeof undoIndex>;
  bulk: ReturnType<typeof bulkIndex>;
  /** An action of the owner's that no undo cancelled. */
  isMine: (e: HistEvent) => boolean;
  firstDay: number;
  days: number;
  weekdays: number[];
  inRange: (t: number) => boolean;
  /** Weekday (0-6) of the local day a moment falls on. */
  wdOf: (t: number) => number;
}

function buildItems(rows: ItemRow[], events: HistEvent[], nowMs: number, mine: Set<string>): Map<string, Item> {
  const items = new Map<string, Item>();
  for (const r of rows) {
    const firstSeen = ms(r.first_seen_at) ?? nowMs;
    const occurred = ms(r.occurred_at) ?? firstSeen;
    const inUniverse = r.is_own === 0 && r.muted === 0 && r.state !== 'archived' && r.state !== 'own';
    const data = r.provider === 'github' ? parseMeta(r.data) : {};
    const author = (r.author ?? '').toLowerCase();
    items.set(r.id, {
      row: r,
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      inUniverse,
      world: inUniverse && r.provider !== 'todo',
      firstSeen,
      occurred,
      live: firstSeen - occurred < LIVE_LAG_MS,
      size:
        r.provider === 'youtube'
          ? (r.replies ?? 0)
          : r.provider === 'github'
            ? typeof data.comments === 'number'
              ? data.comments
              : 0
            : null,
      bot: data.authorType === 'Bot' || author.endsWith('[bot]') || (r.provider === 'github' && mine.has(author)),
      events: [],
    });
  }
  for (const e of events) items.get(e.item)?.events.push(e);
  for (const it of items.values()) it.events.sort((a, b) => a.t - b.t || a.id - b.id);
  return items;
}

function buildContext(db: Db, opts: InsightsOptions, rows: ItemRow[], events: HistEvent[]): Ctx {
  const nowMs = opts.now.getTime();
  const clock = localClock(opts.tz);
  const today = clock.day(nowMs);
  const items = buildItems(rows, events, nowMs, myAccounts(db));

  const undos = undoIndex(events);
  const bulk = bulkIndex(events, { decisions: true });
  const isMine = (e: HistEvent) =>
    e.source === 'user' && (e.kind === 'state' || e.kind === 'snooze' || e.kind === 'reply') && !undos.cancelled(e);

  /* ---- the range, in whole local days ---- */
  const startOfDay = (day: number): number => {
    let g = day * DAY_MS - 15 * HOUR_MS;
    while (clock.day(g) < day) g += 900_000;
    return g;
  };
  let firstDay: number;
  if (opts.range === 'all') {
    let first = Infinity;
    for (const it of items.values()) {
      if (it.world && it.live) first = Math.min(first, it.firstSeen);
      if (it.inUniverse) for (const e of it.events) if (isMine(e)) first = Math.min(first, e.t);
    }
    firstDay = Number.isFinite(first) ? Math.min(today, clock.day(first)) : today;
  } else firstDay = today - RANGE_DAYS[opts.range] + 1;
  const start = startOfDay(firstDay);
  const days = today - firstDay + 1;
  const weekdays = new Array<number>(7).fill(0);
  for (let d = firstDay; d <= today; d++) weekdays[weekday(d)]!++;
  return {
    db,
    opts,
    nowMs,
    clock,
    today,
    items,
    events,
    undos,
    bulk,
    isMine,
    firstDay,
    days,
    weekdays,
    inRange: (t) => t >= start && t <= nowMs,
    wdOf: (t) => weekday(clock.day(t)),
  };
}

const hourlyOf = (g: number[][]) => Array.from({ length: 24 }, (_, h) => g.reduce((a, row) => a + row[h]!, 0));

/* ---- arrivals (R1, sources) ---- */
interface Arrivals {
  arrivals: number[][];
  written: number[][];
  rearrivals: number;
  /** Live arrivals plus re-arrivals. */
  n: number;
  hourly: number[];
  byRepo: Map<string, number>;
  byVideo: Map<string, number>;
  videoLabel: Map<string, string>;
  byChannel: Map<string, number>;
  byAuthor: Map<string, number>;
  byMix: Map<string, number>;
}

function collectArrivals(ctx: Ctx): Arrivals {
  const { items, clock, inRange, wdOf } = ctx;
  const arrivals = grid();
  const written = grid();
  let liveArrivals = 0;
  let rearrivals = 0;
  const byRepo = new Map<string, number>();
  const byVideo = new Map<string, number>();
  const videoLabel = new Map<string, string>();
  const byChannel = new Map<string, number>();
  const byAuthor = new Map<string, number>();
  const byMix = new Map<string, number>();
  const arrived = (it: Item, t: number) => {
    arrivals[wdOf(t)]![clock.hour(t)]!++;
    if (it.provider === 'github' && it.row.container_key) inc(byRepo, it.row.container_key);
    if (it.provider === 'youtube' && it.row.container_key) {
      inc(byVideo, it.row.container_key);
      videoLabel.set(it.row.container_key, it.row.container_title ?? it.row.video_title ?? it.row.container_key);
      if (it.row.channel_title) inc(byChannel, it.row.channel_title);
    }
    inc(byMix, `${it.provider}\t${it.kind}`);
  };
  for (const it of items.values()) {
    if (!it.world) continue;
    if (it.live && inRange(it.firstSeen)) {
      liveArrivals++;
      arrived(it, it.firstSeen);
      written[wdOf(it.occurred)]![clock.hour(it.occurred)]!++;
      if (it.row.author && !it.bot) inc(byAuthor, it.row.author);
    }
    for (const e of it.events) {
      const reason = e.meta.reason;
      if (
        e.kind === 'state' &&
        e.source === 'sync' &&
        e.to === 'inbox' &&
        (reason === 'new_activity' || reason === 'reopened') &&
        inRange(e.t)
      ) {
        rearrivals++;
        arrived(it, e.t);
      }
    }
  }
  return {
    arrivals,
    written,
    rearrivals,
    n: liveArrivals + rearrivals,
    hourly: hourlyOf(arrivals),
    byRepo,
    byVideo,
    videoLabel,
    byChannel,
    byAuthor,
    byMix,
  };
}

/* ---- the owner's actions (R2, F1, P6) ---- */
interface Actions {
  grid: number[][];
  hourly: number[];
  n: number;
  bulkActions: number;
  perDay: Map<number, number>;
  undoKeys: Set<string>;
}

function collectActions(ctx: Ctx): Actions {
  const { items, events, clock, inRange, wdOf, isMine, bulk } = ctx;
  const actionsGrid = grid();
  const actionKeys = new Set<string>();
  let bulkActions = 0;
  const perDay = new Map<number, number>();
  for (const e of events) {
    const it = items.get(e.item);
    if (!it?.inUniverse || !isMine(e) || !inRange(e.t)) continue;
    const a = actionIdOf(e);
    const key = a !== null ? `a${a}` : `e${e.id}`;
    if (actionKeys.has(key)) continue;
    actionKeys.add(key);
    actionsGrid[wdOf(e.t)]![clock.hour(e.t)]!++;
    inc(perDay, clock.day(e.t));
    if (bulk.isBulk(e)) bulkActions++;
  }
  const undoKeys = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'undo' || e.source !== 'user' || !inRange(e.t) || !items.get(e.item)?.inUniverse) continue;
    const a = actionIdOf(e);
    undoKeys.add(a !== null ? `a${a}` : `e${e.id}`);
  }
  return { grid: actionsGrid, hourly: hourlyOf(actionsGrid), n: actionKeys.size, bulkActions, perDay, undoKeys };
}

/* ---- per item: first touch, outcome, resolution, judgement ---- */
interface PerItem {
  outcomeCounts: Record<Outcome, number>;
  outcomeBulk: number;
  waiting: number;
  firstResp: Map<string, number[]>;
  firstRespHour: number[][];
  replyBy: Tally;
  bySize: Map<SizeBand, { n: number; hits: number }>;
  sizeApprox: number;
  ages: Record<'replied' | 'done' | 'dismissed', number[]>;
  /** Things cleared (todos included) and how many of them were replies, for the sentence. */
  dealt: number;
  repliedN: number;
  dealtBy: Map<string, number>;
  biggest: { it: Item; size: number } | null;
  resolvedCount: number;
  replyDays: { youtube: Set<number>; github: Set<number> };
  judged: Judged[];
  judgedBulk: number;
  capturedSince: number | null;
}

function collectPerItem(ctx: Ctx): PerItem {
  const { db, items, clock, inRange, undos, bulk, isMine } = ctx;
  const outcomeCounts: Record<Outcome, number> = {
    replied: 0,
    done: 0,
    dismissed: 0,
    snoozed: 0,
    legacy: 0,
    upstream: 0,
  };
  let outcomeBulk = 0;
  let waiting = 0;
  const firstResp = new Map<string, number[]>();
  const firstRespHour = Array.from({ length: 24 }, () => [] as number[]);
  const replyBy: Tally = new Map();
  const bySize = new Map<SizeBand, { n: number; hits: number }>();
  let sizeApprox = 0;
  const ages: PerItem['ages'] = { replied: [], done: [], dismissed: [] };
  let dealt = 0;
  let repliedN = 0;
  const dealtBy = new Map<string, number>();
  let biggest: { it: Item; size: number } | null = null;
  let resolvedCount = 0;
  const replyDays = { youtube: new Set<number>(), github: new Set<number>() };
  const judged: Judged[] = [];
  let judgedBulk = 0;
  const categoriesNow = currentCategories(db);
  let capturedSince: number | null = null;

  for (const it of items.values()) {
    if (!it.inUniverse) continue;
    let firstTouch: HistEvent | null = null;
    let outcome: { e: HistEvent; what: Outcome } | null = null;
    let resolution: { e: HistEvent; res: ReturnType<typeof resolutionOf> } | null = null;
    let judgedDone = false;
    for (const e of it.events) {
      if (typeof e.meta.suggestedCategory === 'string' && e.source === 'user')
        capturedSince = capturedSince === null ? e.t : Math.min(capturedSince, e.t);
      const res = resolutionOf(e);
      const cancelled = e.source === 'user' && undos.cancelled(e);
      if (isMine(e) && !firstTouch) firstTouch = e;
      if (res && !cancelled && !resolution) resolution = { e, res };
      if (!outcome && !cancelled) {
        if (res) outcome = { e, what: res === 'reply' ? 'replied' : res === 'dismiss' ? 'dismissed' : res };
        else if (e.kind === 'snooze' && e.source === 'user' && e.to) outcome = { e, what: 'snoozed' };
        else if (
          e.kind === 'state' &&
          (e.source === 'sync' || e.source === 'auto') &&
          e.from === 'inbox' &&
          e.to !== null &&
          !['inbox', 'own', 'archived'].includes(e.to)
        )
          // auto_replied: the owner replied further down the YouTube thread, which cleared this one: their reply.
          outcome = { e, what: e.to === 'auto_replied' ? 'replied' : 'upstream' };
      }
      // The suggestion is judged against the owner's first done, dismissal, reply or snooze that carried one (as habits).
      if (!judgedDone && !cancelled && e.source === 'user' && typeof e.meta.suggested === 'string') {
        const action: (typeof FIRST_ACTIONS)[number] | null =
          e.kind === 'snooze'
            ? e.to
              ? 'snooze'
              : null
            : e.kind === 'state'
              ? e.to === 'replied'
                ? 'replied'
                : e.to === 'done'
                  ? e.meta.reason === 'no_action'
                    ? 'dismissed'
                    : e.meta.reason === 'done'
                      ? 'done'
                      : 'legacy'
                  : null
              : null;
        if (action) {
          judgedDone = true;
          if (it.world && inRange(e.t)) {
            if (bulk.isBulk(e)) judgedBulk++;
            else {
              const recorded = typeof e.meta.suggestedCategory === 'string' ? e.meta.suggestedCategory : null;
              const now = categoriesNow.get(it.id) ?? null;
              judged.push({
                suggested: e.meta.suggested,
                action,
                confidence: e.meta.suggestedConfidence,
                turn: e.meta.suggestedTurn,
                category: recorded ?? now,
                approxCategory: recorded === null && now !== null,
              });
            }
          }
        }
      }
    }

    if (!it.world) {
      // Todos: only "things cleared" for the sentence.
      if (resolution && inRange(resolution.e.t) && resolution.res !== null) {
        dealt++;
        inc(dealtBy, `${it.provider}\t${it.kind}`);
      }
      continue;
    }

    if (firstTouch && inRange(it.firstSeen) && !bulk.isBulk(firstTouch)) {
      const dt = Math.max(0, firstTouch.t - it.firstSeen);
      (firstResp.get(it.provider) ?? firstResp.set(it.provider, []).get(it.provider)!).push(dt);
      firstRespHour[clock.hour(it.firstSeen)]!.push(dt);
    }

    if (outcome && inRange(outcome.e.t)) {
      if (outcome.what !== 'upstream' && bulk.isBulk(outcome.e)) outcomeBulk++;
      else outcomeCounts[outcome.what]++;
    } else if (!outcome && it.live && inRange(it.firstSeen) && it.row.state === 'inbox') waiting++;

    if (resolution && inRange(resolution.e.t)) {
      const { e, res } = resolution;
      const replied = res === 'reply';
      dealt++;
      inc(dealtBy, `${it.provider}\t${it.kind}`);
      if (replied) repliedN++;
      const atAct = typeof e.meta.threadSize === 'number' ? (e.meta.threadSize as number) : null;
      const size = atAct ?? it.size ?? 0;
      if ((res === 'reply' || res === 'done' || res === 'legacy') && (!biggest || size > biggest.size)) {
        biggest = { it, size };
      }
      if (res === 'reply' || res === 'done' || res === 'legacy') resolvedCount++;
      if (!bulk.isBulk(e)) {
        const k = `${it.provider}\t${it.kind}`;
        const r = replyBy.get(k) ?? { n: 0, hits: 0 };
        r.n++;
        if (replied) r.hits++;
        replyBy.set(k, r);
        const band = sizeBand(size);
        const b = bySize.get(band) ?? { n: 0, hits: 0 };
        b.n++;
        if (replied) b.hits++;
        bySize.set(band, b);
        if (atAct === null) sizeApprox++;
        const age = Math.max(0, e.t - it.firstSeen);
        if (res === 'reply') ages.replied.push(age);
        else if (res === 'done') ages.done.push(age);
        else if (res === 'dismiss') ages.dismissed.push(age);
      }
    }
    // Polyglot days: every reply of the owner's, not just the first resolution.
    for (const e of it.events) {
      if (resolutionOf(e) !== 'reply' || !inRange(e.t) || (e.source === 'user' && undos.cancelled(e))) continue;
      if (it.provider === 'youtube') replyDays.youtube.add(clock.day(e.t));
      if (it.provider === 'github') replyDays.github.add(clock.day(e.t));
    }
  }
  return {
    outcomeCounts,
    outcomeBulk,
    waiting,
    firstResp,
    firstRespHour,
    replyBy,
    bySize,
    sizeApprox,
    ages,
    dealt,
    repliedN,
    dealtBy,
    biggest,
    resolvedCount,
    replyDays,
    judged,
    judgedBulk,
    capturedSince,
  };
}

const rateRows = <K extends string>(keys: readonly K[], m: Map<K, { n: number; hits: number }>, min: number) =>
  keys.map((k) => {
    const r = m.get(k) ?? { n: 0, hits: 0 };
    return { key: k, n: r.n, hits: r.hits, rate: rate(r.hits, r.n, min) };
  });

/* ---- the sections ---- */

function rhythmSection(ctx: Ctx, arr: Arrivals, act: Actions, per: PerItem): Insights['rhythm'] {
  const { weekdays } = ctx;
  const arrivalsGrid = weekGrid(arr.arrivals, weekdays);
  const actionsWeek = weekGrid(act.grid, weekdays);
  const firstRespN = [...per.firstResp.values()].reduce((a, xs) => a + xs.length, 0);
  return {
    arrivals: card(arr.n, MIN.arrivals, () => ({
      ...arrivalsGrid,
      written: weekGrid(arr.written, weekdays),
      rearrivals: arr.rearrivals,
    })),
    actions: card(act.n, MIN.actions, () => ({ ...actionsWeek, bulkActions: act.bulkActions })),
    hourly: card(Math.min(arr.n, act.n), MIN.arrivals, () => ({ arrivals: arr.hourly, actions: act.hourly })),
    firstResponse: card(firstRespN, MIN.firstResponseRow, () => ({
      rowMin: MIN.firstResponseRow,
      byProvider: [...per.firstResp]
        .map(([provider, xs]) => {
          const ok = xs.length >= MIN.firstResponseRow;
          return {
            provider,
            n: xs.length,
            medianMs: ok ? median(xs) : null,
            p75Ms: ok ? quantile(xs, 0.75) : null,
          };
        })
        .sort((a, b) => b.n - a.n || a.provider.localeCompare(b.provider)),
      byHour: per.firstRespHour.map((xs, hour) => ({
        hour,
        n: xs.length,
        medianMs: xs.length >= MIN.firstResponseRow ? median(xs) : null,
      })),
    })),
  };
}

type SnoozeRow = {
  n: number;
  activity: number;
  fallback: number;
  manual: number;
  timed: number;
  open: number;
  dur: number[];
};

/** Snoozes started in the range (P5), by bucket, with how each one ended. */
function collectSnoozes(ctx: Ctx): { rows: Map<string, SnoozeRow>; n: number } {
  const { items, inRange, undos } = ctx;
  const snoozeRows = new Map<string, SnoozeRow>();
  let snoozeN = 0;
  for (const it of items.values()) {
    if (!it.inUniverse) continue;
    const ev = it.events.filter((e) => e.kind === 'snooze');
    ev.forEach((e, i) => {
      if (e.source !== 'user' || !e.to || !inRange(e.t) || undos.cancelled(e)) return;
      snoozeN++;
      const bucket =
        typeof e.meta.bucket === 'string' ? e.meta.bucket : e.meta.untilActivity ? 'until_activity' : 'none';
      const row = snoozeRows.get(bucket) ?? { n: 0, activity: 0, fallback: 0, manual: 0, timed: 0, open: 0, dur: [] };
      row.n++;
      const end = ev.slice(i + 1).find((x) => !(x.source === 'user' && undos.cancelled(x)));
      if (!end) row.open++;
      else {
        if (end.source === 'user') row.manual++;
        else if (end.source === 'sync' || end.meta.cause === 'activity') row.activity++;
        else if (end.meta.cause === 'fallback') row.fallback++;
        else row.timed++;
        row.dur.push(Math.max(0, end.t - e.t));
      }
      snoozeRows.set(bucket, row);
    });
  }
  return { rows: snoozeRows, n: snoozeN };
}

function responsesSection(ctx: Ctx, act: Actions, per: PerItem): Insights['responses'] {
  const { ages } = per;
  const snoozes = collectSnoozes(ctx);
  const replySourceRows = [...per.replyBy]
    .map(([k, r]) => ({ ...splitKey(k), n: r.n, hits: r.hits, rate: rate(r.hits, r.n, MIN.rateRow) }))
    .sort((a, b) => b.n - a.n || a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind));
  const resolvedSingle = replySourceRows.reduce((a, r) => a + r.n, 0);
  return {
    outcomes: card(
      OUTCOME_KEYS.reduce((a, k) => a + per.outcomeCounts[k], 0),
      MIN.outcomes,
      () => ({ counts: per.outcomeCounts, waiting: per.waiting, bulk: per.outcomeBulk }),
    ),
    replyBySource: card(resolvedSingle, MIN.rateRow, () => ({ rowMin: MIN.rateRow, rows: replySourceRows })),
    replyBySize: card(resolvedSingle, MIN.rateRow, () => ({
      rowMin: MIN.rateRow,
      rows: rateRows(SIZE_BANDS, per.bySize, MIN.rateRow).map(({ key, ...r }) => ({ band: key, ...r })),
      approx: per.sizeApprox,
    })),
    ageWhenAnswered: card(ages.replied.length + ages.done.length + ages.dismissed.length, MIN.rateRow, () => ({
      rowMin: MIN.rateRow,
      rows: (['replied', 'done', 'dismissed'] as const).map((outcome) => {
        const xs = ages[outcome];
        const ok = xs.length >= MIN.rateRow;
        return {
          outcome,
          n: xs.length,
          p25Ms: ok ? quantile(xs, 0.25) : null,
          medianMs: ok ? median(xs) : null,
          p75Ms: ok ? quantile(xs, 0.75) : null,
        };
      }),
    })),
    snoozes: card(snoozes.n, MIN.snoozes, () => ({
      rows: [...snoozes.rows]
        .map(([bucket, r]) => ({
          bucket,
          n: r.n,
          activity: r.activity,
          fallback: r.fallback,
          manual: r.manual,
          timed: r.timed,
          open: r.open,
          medianMs: median(r.dur),
        }))
        .sort((a, b) => b.n - a.n || a.bucket.localeCompare(b.bucket)),
    })),
    undos: card(act.n, MIN.undos, () => ({ undos: act.undoKeys.size, actions: act.n })),
  };
}

function predictionsSection(per: PerItem): Insights['predictions'] {
  const { judged } = per;
  const scored = judged.filter((j) => !(j.action === 'legacy' && j.suggested !== 'reply'));
  const hit = (j: Judged) => (AGREES[j.suggested] ?? []).includes(j.action);
  const tally = <K extends string>(keys: readonly K[], keyOf: (j: Judged) => unknown, hitOf = hit) => {
    const m = new Map<K, { n: number; hits: number }>();
    for (const j of scored) {
      const k = keyOf(j);
      if (typeof k !== 'string' || !(keys as readonly string[]).includes(k)) continue;
      const r = m.get(k as K) ?? { n: 0, hits: 0 };
      r.n++;
      if (hitOf(j)) r.hits++;
      m.set(k as K, r);
    }
    return rateRows(keys, m, MIN.rateRow);
  };
  const bySuggestion = tally(SUGGESTED, (j) => j.suggested);
  const byConfidence = tally(CONFIDENCES, (j) => j.confidence);
  const byTurn = tally(
    TURNS,
    (j) => j.turn,
    (j) => j.action === 'replied',
  );
  const hits = scored.filter(hit).length;
  const cells = SUGGESTED.map((s) =>
    FIRST_ACTIONS.map((a) => judged.filter((j) => j.suggested === s && j.action === a).length),
  );
  const catMap = new Map<string, { n: number; overrides: number; approx: number }>();
  for (const j of scored) {
    if (!j.category) continue;
    const c = catMap.get(j.category) ?? { n: 0, overrides: 0, approx: 0 };
    c.n++;
    if (!hit(j)) c.overrides++;
    if (j.approxCategory) c.approx++;
    catMap.set(j.category, c);
  }
  const catRows = [...catMap]
    .map(([category, c]) => ({ category, ...c, rate: rate(c.overrides, c.n, MIN.rateRow) }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.n - a.n || a.category.localeCompare(b.category))
    .slice(0, TOP_RANKED);
  const catN = [...catMap.values()].reduce((a, c) => a + c.n, 0);
  const high = byConfidence.find((r) => r.key === 'high')!;
  const medium = byConfidence.find((r) => r.key === 'medium')!;
  const { capturedSince } = per;
  return {
    agreement: card(scored.length, MIN.agreement, () => ({
      hits,
      total: scored.length,
      ambiguous: judged.length - scored.length,
      bulk: per.judgedBulk,
    })),
    bySuggestion: card(scored.length, MIN.rateRow, () => ({
      rowMin: MIN.rateRow,
      rows: bySuggestion.map(({ key, ...r }) => ({ suggested: key, ...r })),
    })),
    calibration: card(scored.length, MIN.rateRow, () => ({
      rowMin: MIN.rateRow,
      rows: byConfidence.map(({ key, ...r }) => ({ confidence: key, ...r })),
      highNotBetter: high.rate !== null && medium.rate !== null && high.rate <= medium.rate,
    })),
    confusion: card(judged.length, MIN.confusion, () => ({ cells })),
    categories: card(catN, MIN.rateRow, () => ({
      rowMin: MIN.rateRow,
      rows: catRows,
      capturedSince: capturedSince === null ? null : new Date(capturedSince).toISOString(),
    })),
    turns: card(
      byTurn.reduce((a, r) => a + r.n, 0),
      MIN.rateRow,
      () => ({ rowMin: MIN.rateRow, rows: byTurn.map(({ key, ...r }) => ({ turn: key, ...r })) }),
    ),
  };
}

/** The biggest threads touched in the range (S5). */
function collectThreads(ctx: Ctx): { it: Item; size: number }[] {
  const { items, inRange } = ctx;
  const threads = new Map<string, { it: Item; size: number }>();
  for (const it of items.values()) {
    if (!it.world || it.size === null) continue;
    const touched = (it.live && inRange(it.firstSeen)) || it.events.some((e) => inRange(e.t));
    if (!touched) continue;
    const key = it.provider === 'youtube' && it.row.thread_id ? `yt:${it.row.thread_id}` : it.id;
    const cur = threads.get(key);
    // A YouTube thread is many items: link to its top comment when that is one of them.
    if (!cur || it.size > cur.size || (it.row.thread_id === it.id && cur.it.id !== it.id))
      threads.set(key, { it, size: it.size });
  }
  return [...threads.values()].sort((a, b) => b.size - a.size || a.it.id.localeCompare(b.it.id));
}

function sourcesSection(ctx: Ctx, arr: Arrivals): Insights['sources'] {
  const bigThreads = collectThreads(ctx);
  const repos = ranked(arr.byRepo, TOP_RANKED);
  const videos = ranked(
    new Map([...arr.byVideo].map(([k, n]) => [arr.videoLabel.get(k) ?? k, n] as [string, number])),
    TOP_RANKED,
  );
  const channels = ranked(arr.byChannel, Infinity).rows.filter((r) => r.n >= MIN.channelRow);
  const regulars = ranked(arr.byAuthor, Infinity).rows.filter((r) => r.n >= MIN.regularRow);
  const mixAll = [...arr.byMix]
    .map(([k, n]) => ({ ...splitKey(k), n }))
    .sort((a, b) => b.n - a.n || a.provider.localeCompare(b.provider));
  const mixParts =
    mixAll.length <= MIX_PARTS
      ? mixAll
      : [
          ...mixAll.slice(0, MIX_PARTS - 1),
          { provider: 'other', kind: 'other', n: mixAll.slice(MIX_PARTS - 1).reduce((a, p) => a + p.n, 0) },
        ];
  return {
    repos: card(arr.byRepo.size ? repos.rows.reduce((a, r) => a + r.n, 0) + repos.other : 0, MIN.repos, () => repos),
    videos: card(
      arr.byVideo.size ? videos.rows.reduce((a, r) => a + r.n, 0) + videos.other : 0,
      MIN.videos,
      () => videos,
    ),
    channels: card(channels.length, MIN.channels, () => ({ rowMin: MIN.channelRow, rows: channels })),
    regulars: card(regulars[0]?.n ?? 0, MIN.regularRow, () => ({
      rowMin: MIN.regularRow,
      rows: regulars.slice(0, TOP_REGULARS),
    })),
    threads: card(bigThreads[0]?.size ?? 0, MIN.bigThread, () => ({
      rows: bigThreads
        .filter((t) => t.size >= MIN.bigThread)
        .slice(0, TOP_THREADS)
        .map((t) => ({ ...refOf(t.it), size: t.size })),
    })),
    mix: card(arr.n, MIN.mix, () => ({ parts: mixParts })),
  };
}

/** The backlog right now: ignores the range. */
function backlogSection(ctx: Ctx): Insights['backlog'] {
  const { db, items, nowMs, clock, opts, firstDay, today } = ctx;
  const inboxAges: { it: Item; since: number; age: number }[] = [];
  const snoozedNow = new Map<string, number[]>();
  for (const it of items.values()) {
    if (!it.inUniverse || it.row.state !== 'inbox') continue;
    const until = ms(it.row.snoozed_until);
    if (until !== null && until > nowMs) {
      const bucket = it.row.snooze_bucket ?? 'none';
      const at = ms(it.row.snoozed_at);
      (snoozedNow.get(bucket) ?? snoozedNow.set(bucket, []).get(bucket)!).push(
        at === null ? NaN : Math.max(0, nowMs - at) / DAY_MS,
      );
      continue;
    }
    const since = ms(it.row.woke_at) ?? it.firstSeen;
    inboxAges.push({ it, since, age: Math.max(0, nowMs - since) });
  }
  const elder = inboxAges.reduce<(typeof inboxAges)[number] | null>(
    (a, x) => (!a || x.since < a.since || (x.since === a.since && x.it.id < a.it.id) ? x : a),
    null,
  );

  let overTime: InsightCard<{ days: { day: string; count: number }[] }>;
  try {
    const counts = inboxCountByDay(db, { now: nowMs, tz: opts.tz, from: firstDay, to: today });
    overTime = card(counts.length, MIN.overTimeDays, () => ({
      days: counts.map((c) => ({ day: clock.key(c.day), count: c.count })),
    }));
  } catch {
    overTime = nullCard(MIN.overTimeDays);
  }
  return {
    inboxAge: card(inboxAges.length, MIN.backlog, () => ({
      bands: AGE_BANDS.map((band) => ({ band, n: inboxAges.filter((x) => ageBand(x.age) === band).length })),
    })),
    elder: card(inboxAges.length, MIN.backlog, () => ({
      ...refOf(elder!.it),
      since: new Date(elder!.since).toISOString(),
      ageMs: elder!.age,
    })),
    snoozedNow: card(
      [...snoozedNow.values()].reduce((a, xs) => a + xs.length, 0),
      MIN.backlog,
      () => ({
        rows: [...snoozedNow]
          .map(([bucket, xs]) => ({ bucket, n: xs.length, medianDays: median(xs.filter((x) => !Number.isNaN(x))) }))
          .sort((a, b) => b.n - a.n || a.bucket.localeCompare(b.bucket)),
      }),
    ),
    overTime,
  };
}

function extrasSection(ctx: Ctx, arr: Arrivals, act: Actions, per: PerItem): Insights['extras'] {
  const { days, clock } = ctx;
  let busiest: { day: number; n: number } | null = null;
  for (const [day, n] of act.perDay)
    if (!busiest || n > busiest.n || (n === busiest.n && day > busiest.day)) busiest = { day, n };
  const quietest = (() => {
    let best: { hour: number; perDay: number } | null = null;
    for (let h = 0; h < 24; h++) {
      const v = arr.hourly[h]! / Math.max(1, days);
      if (!best || v < best.perDay) best = { hour: h, perDay: v };
    }
    return best!;
  })();
  const { replyDays, biggest } = per;
  const polyDays = [...replyDays.youtube].filter((d) => replyDays.github.has(d)).sort((a, b) => a - b);
  const allReplyDays = new Set([...replyDays.youtube, ...replyDays.github]);
  return {
    busiestDay: card(act.n, 1, () => ({ day: clock.key(busiest!.day), actions: busiest!.n })),
    quietestHour: card(days >= MIN.quietestHourDays ? arr.n : 0, MIN.arrivals, () => quietest),
    biggestCleared: card(per.resolvedCount, 1, () => ({ ...refOf(biggest!.it), size: biggest!.size })),
    polyglot: card(allReplyDays.size, 1, () => ({
      days: polyDays.length,
      last: polyDays.length ? clock.key(polyDays[polyDays.length - 1]!) : null,
    })),
  };
}

/** Work out every card. Read only. Throws RangeError for an unknown time zone. */
export function insightsReport(db: Db, opts: InsightsOptions): Insights {
  checkTimeZone(opts.tz);
  let rows: ItemRow[];
  let events: HistEvent[];
  try {
    rows = loadItems(db);
    events = loadEvents(db, ['state', 'snooze', 'reply', 'undo', 'decision']);
  } catch {
    return emptyInsights(opts); // a database from before the columns this reads
  }
  const ctx = buildContext(db, opts, rows, events);
  const arr = collectArrivals(ctx);
  const act = collectActions(ctx);
  const per = collectPerItem(ctx);

  const rhythm = rhythmSection(ctx, arr, act, per);
  const responses = responsesSection(ctx, act, per);
  const predictions = predictionsSection(per);
  const sources = sourcesSection(ctx, arr);
  const backlog = backlogSection(ctx);
  const extras = extrasSection(ctx, arr, act, per);

  // A repo reads as a name; a video title is quoted so the sentence still parses.
  const loudest = [
    sources.repos.data?.rows[0],
    sources.videos.data?.rows[0] && { ...sources.videos.data.rows[0], label: `‘${sources.videos.data.rows[0].label}’` },
  ]
    .filter((r): r is RankedRow => !!r)
    .sort((a, b) => b.n - a.n)[0];
  const anything =
    [...ctx.items.values()].some((it) => it.world) ||
    events.some((e) => e.source === 'user' && ctx.items.get(e.item)?.inUniverse);

  return {
    range: opts.range,
    tz: opts.tz,
    generatedAt: opts.now.toISOString(),
    from: ctx.clock.key(ctx.firstDay),
    days: ctx.days,
    sentence: insightsSentence({
      range: opts.range,
      actions: act.n,
      dealt: per.dealt,
      dealtBy: [...per.dealtBy].map(([k, n]) => ({ ...splitKey(k), n })),
      replied: per.repliedN,
      hourlyActions: rhythm.actions.data ? act.hourly : null,
      loudest: loudest?.label ?? null,
      agreement: predictions.agreement.data,
    }),
    empty: !anything,
    rhythm,
    responses,
    predictions,
    sources,
    backlog,
    extras,
  };
}

const OUTCOME_KEYS: readonly Outcome[] = ['replied', 'done', 'dismissed', 'snoozed', 'legacy', 'upstream'];

/** The reader the route uses: reports cached by range, zone, history and local date, for at most five minutes. */
export interface InsightsReader {
  report(range: InsightsRange, tz: string): Insights;
}
const CACHE_MAX = 8;
const CACHE_TTL_MS = 5 * 60_000;

export function createInsightsReader(db: Db, clock: () => Date = () => new Date()): InsightsReader {
  let stamp: Statement | null = null;
  const cache = new Map<string, { at: number; value: Insights }>();
  return {
    report(range, tz) {
      checkTimeZone(tz);
      const now = clock();
      stamp ??= db.prepare(
        `SELECT (SELECT MAX(id) FROM item_events) AS e, (SELECT MAX(rowid) FROM items) AS i,
                (SELECT COUNT(*) FROM items) AS n`,
      );
      // Items change without events (refreshed comment counts, mutes), so entries also expire after a while.
      const s = stamp.get() as Record<string, unknown>;
      const key = JSON.stringify([range, tz, s.e, s.i, s.n, localClock(tz).day(now.getTime())]);
      const hit = cache.get(key);
      if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.value;
      const value = insightsReport(db, { range, tz, now });
      cache.delete(key);
      cache.set(key, { at: now.getTime(), value });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return value;
    },
  };
}
