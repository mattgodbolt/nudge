import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_RANGES,
  kindWord,
  type AgeBand,
  type InsightCard,
  type Insights,
  type InsightsRange,
  type Outcome,
  type SizeBand,
} from '../../../shared/insights';
import { loadRaw, saveRaw } from './storage';

/** Pure helpers for the Insights section: words, numbers and captions. The server decides every figure. */

export const RANGE_LABEL: Record<InsightsRange, string> = { '7d': '7d', '30d': '30d', '90d': '90d', all: 'All' };
const RANGE_KEY = 'nudge.insights.range';

/** The remembered range; the default when there is none or storage is unavailable. */
export function loadRange(storage?: Pick<Storage, 'getItem'> | null): InsightsRange {
  const v = storage === undefined ? loadRaw(RANGE_KEY) : loadRaw(RANGE_KEY, storage);
  return (INSIGHTS_RANGES as readonly string[]).includes(v ?? '') ? (v as InsightsRange) : DEFAULT_INSIGHTS_RANGE;
}
export function saveRange(r: InsightsRange, storage?: Pick<Storage, 'setItem'> | null): void {
  if (storage === undefined) saveRaw(RANGE_KEY, r);
  else saveRaw(RANGE_KEY, r, storage);
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "Not enough data yet (12 of 50)". */
export const lowData = (c: InsightCard<unknown>) => `Not enough data yet (${c.n} of ${c.min})`;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 0 → "12am", 13 → "1pm". */
export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24;
  return `${x % 12 === 0 ? 12 : x % 12}${x < 12 ? 'am' : 'pm'}`;
}
/** Compact axis label: "12a", "6a", "12p", "6p". */
export const hourTick = (h: number) => hourLabel(h).replace('am', 'a').replace('pm', 'p');

/** 0.4123 → "41%". */
export const pct = (r: number | null | undefined) => (r === null || r === undefined ? '–' : `${Math.round(r * 100)}%`);

/** A duration, short: "45m", "6h", "2d", "3mo". */
export function shortDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  const m = ms / 60_000;
  if (m < 1) return '<1m';
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 90) return `${Math.round(d)}d`;
  return `${Math.round(d / 30)}mo`;
}

/** A per-day average: "0.4", "3", "12". */
export const perDayLabel = (x: number) =>
  x === 0 ? '0' : x < 10 ? x.toFixed(1).replace(/\.0$/, '') : String(Math.round(x));

export const SIZE_BAND_LABEL: Record<SizeBand, string> = {
  '0': 'No comments',
  '1-3': '1–3 comments',
  '4-10': '4–10 comments',
  '11+': '11 or more',
};
export const AGE_BAND_LABEL: Record<AgeBand, string> = {
  '<1d': 'Under a day',
  '1-7d': '1–7 days',
  '1-4w': '1–4 weeks',
  '1-3m': '1–3 months',
  '3m+': '3 months+',
};
export const OUTCOME_LABEL: Record<Outcome, string> = {
  replied: 'Replied',
  done: 'Done',
  dismissed: 'No action needed',
  snoozed: 'Snoozed first',
  legacy: 'Done (before dismissals)',
  upstream: 'Closed elsewhere',
};
const BUCKET_LABEL: Record<string, string> = {
  waiting_on_them: 'Waiting on them',
  waiting_on_merge: 'Waiting on merge',
  in_flight: 'In flight',
  lower_priority: 'Lower priority',
  until_activity: 'Until activity',
  none: 'Plain timed',
};
export const bucketLabel = (b: string) => BUCKET_LABEL[b] ?? b.replace(/_/g, ' ');
export const SUGGESTED_LABEL: Record<string, string> = {
  reply: 'Reply',
  act: 'Act',
  skip: 'Skip',
  spam: 'Spam',
};
export const ACTION_LABEL: Record<string, string> = {
  replied: 'Replied',
  done: 'Done',
  dismissed: 'No action',
  snooze: 'Snoozed',
  legacy: 'Done (old)',
};
export const TURN_LABEL: Record<string, string> = { me: 'Your turn', them: 'Their turn', nobody: "Nobody's turn" };
const PROVIDER_LABEL: Record<string, string> = { github: 'GitHub', youtube: 'YouTube', todo: 'Todos' };
export const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;
export const kindLabel = (provider: string, kind: string) =>
  provider === 'other' ? 'Other' : kindWord(provider, kind).replace(/^./, (c) => c.toUpperCase());

/** Steps of the sequential ramp (1..7) for a value against the chart's maximum; 0 means none at all. */
export function heatLevel(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(7, Math.ceil((v / max) * 7)));
}

/** Local date "2026-10-14" → "14 Oct". */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
/** An ISO time → "March" (this year) or "March 2025". */
export function monthLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString('en-GB', { month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

/* ---------------- captions: describe, never explain, never scold ---------------- */

const arrivalQuip = (h: number) =>
  h < 6
    ? 'Night owls are typing.'
    : h < 12
      ? 'The world wakes up and chooses comments.'
      : h < 18
        ? 'The internet has opinions after lunch.'
        : 'Evening thoughts, delivered.';
const actionQuip = (h: number) =>
  h >= 5 && h < 12
    ? 'The coffee window.'
    : h >= 12 && h < 18
      ? 'Post-lunch productivity.'
      : h >= 18 && h < 23
        ? 'Evening tidying.'
        : 'Burning the midnight oil, gently.';

/** The busiest two-hour stretch of a 24-hour count, as "8–10am". */
export function busiestWindow(hourly: readonly number[]): { from: number; label: string } | null {
  let best = -1;
  let from = 0;
  for (let h = 0; h < 24; h++) {
    const v = (hourly[h] ?? 0) + (hourly[(h + 1) % 24] ?? 0);
    if (v > best) {
      best = v;
      from = h;
    }
  }
  if (best <= 0) return null;
  const a = hourLabel(from);
  const b = hourLabel(from + 2);
  const sameHalf = a.slice(-2) === b.slice(-2);
  return { from, label: sameHalf ? `${a.slice(0, -2)}–${b}` : `${a}–${b}` };
}

type Ins = Insights;

export const captions = {
  arrivals(i: Ins): string | null {
    const p = i.rhythm.arrivals.data?.peak;
    return p ? `Peak arrivals: ${WEEKDAYS[p.weekday]}s ${hourLabel(p.hour)}. ${arrivalQuip(p.hour)}` : null;
  },
  actions(i: Ins): string | null {
    const d = i.rhythm.actions.data;
    if (!d) return null;
    const hourly = Array.from({ length: 24 }, (_, h) => d.counts.reduce((a, row) => a + row[h]!, 0));
    const w = busiestWindow(hourly);
    return w ? `Mostly ${w.label}. ${actionQuip(w.from + 1)}` : null;
  },
  firstResponse(i: Ins): string | null {
    const rows = i.rhythm.firstResponse.data?.byProvider.filter((r) => r.medianMs !== null) ?? [];
    if (!rows.length) return null;
    return `Median ${rows.map((r) => `${shortDuration(r.medianMs)} for ${providerLabel(r.provider)}`).join(', ')}.`;
  },
  outcomes(i: Ins): string | null {
    const d = i.responses.outcomes.data;
    if (!d) return null;
    const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
    const part = (k: Outcome) => Math.round((100 * d.counts[k]) / Math.max(1, total));
    return `${part('replied')}% replied, ${part('done')}% done, ${part('dismissed')}% waved through.`;
  },
  replyBySource(i: Ins): string | null {
    const rows = (i.responses.replyBySource.data?.rows ?? []).filter((r) => r.rate !== null);
    if (rows.length < 2)
      return rows[0] ? `You reply to ${pct(rows[0].rate)} of ${kindWord(rows[0].provider, rows[0].kind)}.` : null;
    const top = [...rows].sort((a, b) => b.rate! - a.rate!)[0]!;
    return `You reply most to ${kindWord(top.provider, top.kind)}.`;
  },
  replyBySize(i: Ins): string | null {
    const rows = i.responses.replyBySize.data?.rows ?? [];
    const small =
      rows.find((r) => r.band === '1-3' && r.rate !== null) ?? rows.find((r) => r.band === '0' && r.rate !== null);
    const big =
      rows.find((r) => r.band === '11+' && r.rate !== null) ?? rows.find((r) => r.band === '4-10' && r.rate !== null);
    if (!small || !big || small === big) return null;
    if (small.rate! > big.rate! + 0.1) return 'Short threads get answers; epics get the slow treatment.';
    if (big.rate! > small.rate! + 0.1) return 'The big conversations pull you in.';
    return 'Thread size makes little difference to whether you reply.';
  },
  ageWhenAnswered(i: Ins): string | null {
    const r = i.responses.ageWhenAnswered.data?.rows.find((x) => x.outcome === 'replied' && x.medianMs !== null);
    return r ? `Replies go out at a median age of ${shortDuration(r.medianMs)}.` : null;
  },
  snoozes(i: Ins): string | null {
    const rows = (i.responses.snoozes.data?.rows ?? []).filter((r) => r.activity + r.fallback + r.manual + r.timed > 0);
    const r = rows.find((x) => x.bucket !== 'none') ?? rows[0];
    if (!r) return null;
    const ended = r.activity + r.fallback + r.manual + r.timed;
    if (r.activity === 0) return `'${bucketLabel(r.bucket)}' snoozes mostly run their course.`;
    return `'${bucketLabel(r.bucket)}' woke on activity ${Math.round((100 * r.activity) / ended)}% of the time.`;
  },
  undos(i: Ins): string | null {
    const d = i.responses.undos.data;
    if (!d) return null;
    if (d.undos === 0) return 'Ctrl+Z: not needed once. Bold.';
    return `Ctrl+Z: used ${d.undos} time${d.undos === 1 ? '' : 's'}. Nobody's perfect.`;
  },
  agreement(i: Ins): string | null {
    const d = i.predictions.agreement.data;
    if (!d || d.total === 0) return null;
    const r = d.hits / d.total;
    const quip =
      r >= 0.8
        ? 'Not bad for a robot.'
        : r >= 0.6
          ? 'A decent sidekick.'
          : r >= 0.4
            ? 'A coin with opinions.'
            : 'Still learning. Aren’t we all.';
    return `Agreed with you ${pct(r)} of the time (n=${d.total}). ${quip}`;
  },
  calibration(i: Ins): string | null {
    const d = i.predictions.calibration.data;
    if (!d) return null;
    if (d.highNotBetter) return '“High confidence” isn’t earning its badge yet.';
    return d.rows.some((r) => r.confidence === 'high' && r.rate !== null)
      ? '“High confidence” means it, mostly.'
      : null;
  },
  confusion(i: Ins, suggested: readonly string[], actions: readonly string[]): string | null {
    const cells = i.predictions.confusion.data?.cells;
    if (!cells) return null;
    const agree: Record<string, string[]> = {
      reply: ['replied'],
      act: ['done', 'snooze'],
      skip: ['dismissed'],
      spam: ['dismissed'],
    };
    let best: { s: string; a: string; n: number } | null = null;
    cells.forEach((row, si) =>
      row.forEach((n, ai) => {
        const s = suggested[si]!;
        const a = actions[ai]!;
        if (a === 'legacy' || agree[s]?.includes(a)) return;
        if (n > 0 && (!best || n > best.n)) best = { s, a, n };
      }),
    );
    const b = best as { s: string; a: string; n: number } | null;
    return b
      ? `Most common mix-up: it said ${SUGGESTED_LABEL[b.s]?.toLowerCase()}, you ${ACTION_LABEL[b.a]?.toLowerCase()}.`
      : 'No mix-ups worth mentioning.';
  },
  categories(i: Ins): string | null {
    const r = i.predictions.categories.data?.rows.find((x) => x.rate !== null && x.rate > 0);
    return r ? `It thinks '${r.category}' means one thing. You overrule it ${pct(r.rate)} of the time.` : null;
  },
  turns(i: Ins): string | null {
    const r = i.predictions.turns.data?.rows.find((x) => x.turn === 'me' && x.rate !== null);
    return r ? `When it said it was your turn, you replied ${pct(r.rate)} of the time.` : null;
  },
  repos(i: Ins): string | null {
    const r = i.sources.repos.data?.rows[0];
    return r ? `${r.label} has the most to say.` : null;
  },
  videos(i: Ins): string | null {
    const r = i.sources.videos.data?.rows[0];
    return r ? `‘${r.label}’ just won’t stop.` : null;
  },
  channels(i: Ins): string | null {
    const r = i.sources.channels.data?.rows[0];
    return r ? `${r.label} brings the most work.` : null;
  },
  regulars(i: Ins): string | null {
    const r = i.sources.regulars.data?.rows[0];
    return r ? `Your most loyal correspondent: ${r.label}.` : null;
  },
  threads(i: Ins): string | null {
    const r = i.sources.threads.data?.rows[0];
    return r ? `The biggest: ${r.size} comments and counting.` : null;
  },
  mix(i: Ins): string | null {
    const parts = i.sources.mix.data?.parts ?? [];
    const total = parts.reduce((a, p) => a + p.n, 0);
    const top = parts[0];
    return top && top.n * 2 > total ? `Mostly ${kindWord(top.provider, top.kind)}.` : null;
  },
  inboxAge(i: Ins): string | null {
    const b = i.backlog.inboxAge.data?.bands;
    if (!b) return null;
    const total = b.reduce((a, x) => a + x.n, 0);
    const fresh = b.find((x) => x.band === '<1d')?.n ?? 0;
    return fresh === total ? 'Right now. All fresh. Lovely.' : 'Right now. A shape, not a score.';
  },
  elder(i: Ins, now = new Date()): string | null {
    const d = i.backlog.elder.data;
    if (!d) return null;
    if (d.ageMs < 7 * 86_400_000) return 'Nothing old waiting. Tidy.';
    return `Waiting patiently since ${monthLabel(d.since, now)}. It’s fine. It’s fine.`;
  },
  snoozedNow(i: Ins): string | null {
    const rows = i.backlog.snoozedNow.data?.rows;
    if (!rows) return null;
    const n = rows.reduce((a, r) => a + r.n, 0);
    return `Right now: ${n} parked.`;
  },
  overTime(i: Ins): string | null {
    const d = i.backlog.overTime.data?.days;
    if (!d || d.length < 2) return null;
    const a = d[0]!.count;
    const b = d[d.length - 1]!.count;
    return b < a
      ? `From ${a} to ${b}. Shrinking.`
      : b > a
        ? `From ${a} to ${b}. Things pile up; they also go away.`
        : `Steady at ${b}.`;
  },
  busiestDay(i: Ins): string | null {
    const d = i.extras.busiestDay.data;
    return d ? `${dayLabel(d.day)}: ${d.actions} thing${d.actions === 1 ? '' : 's'}. You survived.` : null;
  },
  quietestHour(i: Ins): string | null {
    const d = i.extras.quietestHour.data;
    return d ? `Nothing much ever happens at ${hourLabel(d.hour)}. Respect.` : null;
  },
  biggestCleared(i: Ins): string | null {
    const d = i.extras.biggestCleared.data;
    return d ? (d.size > 0 ? `${d.size} comments deep, and dealt with.` : 'Small and tidy, every one.') : null;
  },
  polyglot(i: Ins): string | null {
    const d = i.extras.polyglot.data;
    if (!d) return null;
    return d.days === 0
      ? 'No day with replies on both YouTube and GitHub yet.'
      : `${d.days} day${d.days === 1 ? '' : 's'} with replies on both YouTube and GitHub. Polyglot.`;
  },
};
