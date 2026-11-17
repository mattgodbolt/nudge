/**
 * Snooze "until activity": the reason buckets, their wording and their default follow-up times. Shared by the server
 * (validation, prompts, habits) and the browser (menu, labels), so the words and the numbers cannot drift apart.
 */

/** Why an item is parked. `waiting_on_*` mean someone else has the next move; the others are the owner's own. */
export const SNOOZE_BUCKETS = ['waiting_on_them', 'waiting_on_merge', 'in_flight', 'lower_priority'] as const;
export type SnoozeBucket = (typeof SNOOZE_BUCKETS)[number];

/** What ended a snooze that was waiting on activity. `manual` = the owner unsnoozed it themselves. */
export const WAKE_CAUSES = ['activity', 'fallback', 'manual'] as const;
export type WakeCause = (typeof WAKE_CAUSES)[number];

export const isSnoozeBucket = (v: unknown): v is SnoozeBucket =>
  typeof v === 'string' && (SNOOZE_BUCKETS as readonly string[]).includes(v);

export interface BucketInfo {
  /** Short name for chips and menus. */
  label: string;
  /** Single key that picks it in the snooze menu. */
  key: string;
  /** Section heading in the Snoozed view. */
  heading: string;
  /** What "still ..." reads after, in the audit line. */
  waitingPhrase: string;
}

export const BUCKETS: Record<SnoozeBucket, BucketInfo> = {
  waiting_on_them: {
    label: 'Waiting on them',
    key: 'w',
    heading: 'Waiting on them',
    waitingPhrase: 'Still waiting on them',
  },
  waiting_on_merge: {
    label: 'Waiting on merge / CI',
    key: 'm',
    heading: 'Waiting on merge / CI',
    waitingPhrase: 'Still waiting on merge / CI',
  },
  in_flight: { label: 'In flight', key: 'f', heading: 'In flight', waitingPhrase: 'Still in flight' },
  lower_priority: {
    label: 'Lower priority',
    key: 'l',
    heading: 'Lower priority / someday',
    waitingPhrase: 'Still parked as lower priority',
  },
};

/** Days an "until activity" snooze waits for activity before it comes back anyway, per bucket (editable in Settings). */
export const DEFAULT_SNOOZE_DAYS: Record<SnoozeBucket, number> = {
  waiting_on_them: 7,
  waiting_on_merge: 3,
  in_flight: 7,
  lower_priority: 30,
};
/** Follow-up for an "until activity" snooze that has no bucket (and no explicit date). */
export const NO_BUCKET_DAYS = 7;
export const SNOOZE_DAYS_MIN = 1;
export const SNOOZE_DAYS_MAX = 365;

const DAY_MS = 86_400_000;

/** The fallback date for an until-activity snooze made at `now`. */
export function fallbackDate(now: Date, bucket: SnoozeBucket | null, days: Record<SnoozeBucket, number>): Date {
  return new Date(now.getTime() + (bucket ? days[bucket] : NO_BUCKET_DAYS) * DAY_MS);
}

/** Whole days between two ISO times, at least 1 (a snooze that came back after hours still waited "1d"). */
export function wholeDays(from: string | null, to: string | null): number {
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / DAY_MS));
}

/** The audit line on an item that came back with no activity: "Still waiting on them (7d, no activity)". */
export function nagText(bucket: SnoozeBucket | null, days: number): string {
  return `${bucket ? BUCKETS[bucket].waitingPhrase : 'Still waiting'} (${days}d, no activity)`;
}

/** "4d" / "2w": a compact age for the Snoozed view. */
export function ageText(from: string | null, now: number): string {
  const t = from ? Date.parse(from) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = Math.max(0, Math.floor((now - t) / DAY_MS));
  return d < 1 ? 'today' : d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`;
}
