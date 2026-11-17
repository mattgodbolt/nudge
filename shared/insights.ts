/**
 * Insights (docs/INSIGHTS.md): the read-only section at the top of Stats. The server decides every card's numbers and
 * whether it has enough data (`data: null` below its minimum); the web app only renders. Shared here so both sides
 * (and their tests) use one shape, and so the one-line summary is built the same everywhere.
 */

export const INSIGHTS_RANGES = ['7d', '30d', '90d', 'all'] as const;
export type InsightsRange = (typeof INSIGHTS_RANGES)[number];
export const DEFAULT_INSIGHTS_RANGE: InsightsRange = '30d';

/** Every card: how much it is based on, the least it needs, and its figure (null while n < min). */
export interface InsightCard<T> {
  n: number;
  min: number;
  data: T | null;
}

/** A week of hours. Index [weekday][hour]; weekday 0 = Sunday, hours are local to the requested zone. */
export interface WeekGrid {
  counts: number[][];
  /** counts ÷ how many of that weekday the range covers (calendar days, not 24h blocks): "per Tuesday". */
  perDay: number[][];
  /** How many Sundays, Mondays, ... the range covers. */
  weekdays: number[];
  peak: { weekday: number; hour: number; perDay: number; count: number } | null;
}

/** A row of a meter list: a share of n, or null when the row is under its own minimum (`rowMin`). */
export interface RateRow {
  n: number;
  hits: number;
  rate: number | null;
}

export interface RankedRow {
  label: string;
  n: number;
}

export interface ItemRef {
  itemId: string;
  /** A title (GitHub), or "author on video title" (YouTube), or the todo's own title. Never the item's body. */
  label: string;
  provider: string;
}

export type Outcome = 'replied' | 'done' | 'dismissed' | 'snoozed' | 'legacy' | 'upstream';
export const OUTCOMES: readonly Outcome[] = ['replied', 'done', 'dismissed', 'snoozed', 'legacy', 'upstream'];
export type SizeBand = '0' | '1-3' | '4-10' | '11+';
export const SIZE_BANDS: readonly SizeBand[] = ['0', '1-3', '4-10', '11+'];
export type AgeBand = '<1d' | '1-7d' | '1-4w' | '1-3m' | '3m+';
export const AGE_BANDS: readonly AgeBand[] = ['<1d', '1-7d', '1-4w', '1-3m', '3m+'];
export const SUGGESTED = ['reply', 'act', 'skip', 'spam'] as const;
/** What the owner did first, for the confusion table: the five columns. */
export const FIRST_ACTIONS = ['replied', 'done', 'dismissed', 'snooze', 'legacy'] as const;
export const CONFIDENCES = ['low', 'medium', 'high'] as const;
export const TURNS = ['me', 'them', 'nobody'] as const;

export interface RhythmInsights {
  /** R1: when things arrive (first_seen_at); `written` is the same items by when they were written (occurred_at). */
  arrivals: InsightCard<WeekGrid & { written: WeekGrid; rearrivals: number }>;
  /** R2: when the owner acts; a bulk action counts once, at its time. */
  actions: InsightCard<WeekGrid & { bulkActions: number }>;
  /** R3: R1 and R2 collapsed to 24 hours (counts). */
  hourly: InsightCard<{ arrivals: number[]; actions: number[] }>;
  /** R4: arrival to the owner's first action, per provider (rows under rowMin carry nulls) and per arrival hour. */
  firstResponse: InsightCard<{
    rowMin: number;
    byProvider: { provider: string; n: number; medianMs: number | null; p75Ms: number | null }[];
    byHour: { hour: number; n: number; medianMs: number | null }[];
  }>;
}

export interface ResponsesInsights {
  /** P1: what happened first to things the owner (or upstream) dealt with in the range; one-at-a-time actions only. */
  outcomes: InsightCard<{ counts: Record<Outcome, number>; waiting: number; bulk: number }>;
  /** P2: of the items the owner resolved themselves, how many got a reply, by provider and kind. */
  replyBySource: InsightCard<{ rowMin: number; rows: (RateRow & { provider: string; kind: string })[] }>;
  /** P3: the same by thread size when the owner acted (`approx` rows used the current size: from before it was recorded). */
  replyBySize: InsightCard<{ rowMin: number; rows: (RateRow & { band: SizeBand })[]; approx: number }>;
  /** P4: age (since Nudge first saw it) when the owner resolved it, by how. */
  ageWhenAnswered: InsightCard<{
    rowMin: number;
    rows: {
      outcome: 'replied' | 'done' | 'dismissed';
      n: number;
      p25Ms: number | null;
      medianMs: number | null;
      p75Ms: number | null;
    }[];
  }>;
  /** P5: snoozes started in the range, by reason, and how they ended. */
  snoozes: InsightCard<{
    rows: {
      bucket: string;
      n: number;
      activity: number;
      fallback: number;
      manual: number;
      timed: number;
      open: number;
      medianMs: number | null;
    }[];
  }>;
  /** P6: undos (distinct actions undone) against all the owner's actions. */
  undos: InsightCard<{ undos: number; actions: number }>;
}

export interface PredictionsInsights {
  /** M1: suggestions judged against the owner's first action (one-at-a-time only; a bare legacy done is not judged). */
  agreement: InsightCard<{ hits: number; total: number; ambiguous: number; bulk: number }>;
  /** M2 */
  bySuggestion: InsightCard<{ rowMin: number; rows: (RateRow & { suggested: (typeof SUGGESTED)[number] })[] }>;
  /** M3 (`highNotBetter`: high confidence agreed no more often than medium, both measured). */
  calibration: InsightCard<{
    rowMin: number;
    rows: (RateRow & { confidence: (typeof CONFIDENCES)[number] })[];
    highNotBetter: boolean;
  }>;
  /** M4: counts, [suggested][first action] in SUGGESTED × FIRST_ACTIONS order. */
  confusion: InsightCard<{ cells: number[][] }>;
  /** M5: how often the owner went against the suggestion, by its category. `approx` rows used today's category. */
  categories: InsightCard<{
    rowMin: number;
    rows: { category: string; n: number; overrides: number; rate: number | null; approx: number }[];
    capturedSince: string | null;
  }>;
  /** M6: whose turn the model said it was, and how often the owner then replied. */
  turns: InsightCard<{ rowMin: number; rows: (RateRow & { turn: (typeof TURNS)[number] })[] }>;
}

export interface SourcesInsights {
  /** S1: GitHub repos by arrivals (and re-arrivals); top 8, the rest in `other`. */
  repos: InsightCard<{ rows: RankedRow[]; other: number }>;
  /** S2: YouTube videos by arrivals; top 8. */
  videos: InsightCard<{ rows: RankedRow[]; other: number }>;
  /** S3: YouTube channels by arrivals (channels with at least `rowMin`). */
  channels: InsightCard<{ rowMin: number; rows: RankedRow[] }>;
  /** S4: people who wrote most (distinct items; the owner's own and bots left out); those with at least `rowMin`, top 5. */
  regulars: InsightCard<{ rowMin: number; rows: RankedRow[] }>;
  /** S5: the biggest conversations that arrived or were acted on in the range (current size). */
  threads: InsightCard<{ rows: (ItemRef & { size: number })[] }>;
  /** S6: arrivals by provider and kind. */
  mix: InsightCard<{ parts: { provider: string; kind: string; n: number }[] }>;
}

export interface BacklogInsights {
  /** B1: what waits in the inbox right now, by age (ignores the range). */
  inboxAge: InsightCard<{ bands: { band: AgeBand; n: number }[] }>;
  /** B2: the oldest thing waiting. */
  elder: InsightCard<ItemRef & { since: string; ageMs: number }>;
  /** B3: snoozed right now, by reason, with the median days parked so far. */
  snoozedNow: InsightCard<{ rows: { bucket: string; n: number; medianDays: number | null }[] }>;
  /** B4: the inbox count at the end of each local day in the range (replayed from the history). */
  overTime: InsightCard<{ days: { day: string; count: number }[] }>;
}

export interface ExtrasInsights {
  /** F1: the local day with the most actions in the range (a bulk action counts once). */
  busiestDay: InsightCard<{ day: string; actions: number }>;
  /** F2: the hour with the fewest arrivals per day (needs R1's minimum and a week of range). */
  quietestHour: InsightCard<{ hour: number; perDay: number }>;
  /** F3: the biggest thread the owner replied to or closed in the range (current size). */
  biggestCleared: InsightCard<ItemRef & { size: number }>;
  /** F5: days with a reply on both YouTube and GitHub. */
  polyglot: InsightCard<{ days: number; last: string | null }>;
}

export interface Insights {
  range: InsightsRange;
  tz: string;
  generatedAt: string;
  /** The first local day the range covers (YYYY-MM-DD), and how many calendar days it spans; null when empty. */
  from: string | null;
  days: number;
  /** F4: the week in one sentence. */
  sentence: string;
  /** True when there is nothing at all to say yet (no arrivals and no actions, ever). */
  empty: boolean;
  rhythm: RhythmInsights;
  responses: ResponsesInsights;
  predictions: PredictionsInsights;
  sources: SourcesInsights;
  backlog: BacklogInsights;
  extras: ExtrasInsights;
}

/* ---------------- F4: the one-sentence summary ---------------- */

const KIND_WORDS: Record<string, string> = {
  'github pr': 'PRs',
  'github issue': 'issues',
  'youtube comment': 'YouTube comments',
  'todo todo': 'todos',
};
export const kindWord = (provider: string, kind: string): string =>
  KIND_WORDS[`${provider} ${kind}`] ?? `${provider} ${kind}s`;

/** "4 times in 5" style, for the robot's agreement rate. */
export function fractionWords(rate: number): string {
  if (rate >= 0.97) return 'basically every time';
  const choices: [number, number][] = [
    [9, 10],
    [4, 5],
    [3, 4],
    [2, 3],
    [3, 5],
    [1, 2],
    [2, 5],
    [1, 3],
    [1, 4],
    [1, 5],
  ];
  if (rate < 0.15) return 'hardly ever';
  let best = choices[0]!;
  for (const c of choices) if (Math.abs(c[0] / c[1] - rate) < Math.abs(best[0] / best[1] - rate)) best = c;
  return `${best[0]} time${best[0] === 1 ? '' : 's'} in ${best[1]}`;
}

/** The part of the day most of the actions fell in (more than half of them), or null. */
export function dayPart(hourly: readonly number[]): string | null {
  const total = hourly.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const parts: [string, number[]][] = [
    ['before lunch', [5, 6, 7, 8, 9, 10, 11]],
    ['in the afternoon', [12, 13, 14, 15, 16, 17]],
    ['in the evening', [18, 19, 20, 21, 22]],
    ['after midnight', [23, 0, 1, 2, 3, 4]],
  ];
  for (const [name, hours] of parts) {
    if (hours.reduce((a, h) => a + (hourly[h] ?? 0), 0) * 2 > total) return name;
  }
  return null;
}

const QUIET: Record<InsightsRange, string> = {
  '7d': 'A quiet week. Lovely.',
  '30d': 'A quiet month. Lovely.',
  '90d': 'A quiet few months. Lovely.',
  all: 'All quiet so far. Lovely.',
};
/** Fewer actions than this in the range and the sentence just says it was quiet. */
export const SENTENCE_MIN_ACTIONS = 10;

/**
 * F4. Deterministic: a handful of templates, each part included only when the number behind it cleared its card's
 * minimum. Describes, never explains, and never scolds.
 */
export function insightsSentence(p: {
  range: InsightsRange;
  actions: number;
  /** Items the owner resolved in the range (replied, done or dismissed, bulk included), and by provider/kind. */
  dealt: number;
  dealtBy: { provider: string; kind: string; n: number }[];
  replied: number;
  hourlyActions: readonly number[] | null;
  loudest: string | null;
  agreement: { hits: number; total: number } | null;
}): string {
  if (p.actions < SENTENCE_MIN_ACTIONS || p.dealt === 0) return QUIET[p.range];
  const top = [...p.dealtBy].sort((a, b) => b.n - a.n)[0];
  const mostly = top && top.n * 2 > p.dealt ? `mostly ${kindWord(top.provider, top.kind)}` : null;
  const when = p.hourlyActions ? dayPart(p.hourlyActions) : null;
  const things = (n: number) => `${n} thing${n === 1 ? '' : 's'}`;
  let first =
    p.replied > 0
      ? `You answered ${things(p.replied)}${p.dealt > p.replied ? ` and cleared ${p.dealt - p.replied} more` : ''}`
      : `You cleared ${things(p.dealt)}`;
  const extra = [mostly, when ? `mostly ${when}` : null].filter(Boolean);
  if (extra.length) first += `, ${extra.join(', ')}`;
  const rest: string[] = [];
  if (p.loudest) rest.push(`${p.loudest} was the loudest`);
  if (p.agreement && p.agreement.total > 0)
    rest.push(`the robot agreed ${fractionWords(p.agreement.hits / p.agreement.total)}`);
  return rest.length ? `${first}; ${rest.join(' and ')}.` : `${first}.`;
}
