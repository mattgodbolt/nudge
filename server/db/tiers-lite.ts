import type { PollTier } from '../../shared/types.js';

// Minimal, dependency-free copy of the polling-tier table (plan section 4).
// server/sync/tiers.ts should be reconciled with (or import) this file.
const MIN = 1;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface TierInfo {
  tier: PollTier;
  /** Minutes between polls; null when paused. */
  intervalMin: number | null;
  /** Minutes between deep scans; null when paused. */
  deepEveryMin: number | null;
}

const TABLE: Record<Exclude<PollTier, 'paused'>, { intervalMin: number; deepEveryMin: number }> = {
  hot: { intervalMin: 10 * MIN, deepEveryMin: 6 * HOUR },
  warm: { intervalMin: HOUR, deepEveryMin: DAY },
  cold: { intervalMin: 12 * HOUR, deepEveryMin: 7 * DAY },
  frozen: { intervalMin: 48 * HOUR, deepEveryMin: 30 * DAY },
};

export function tierInfo(tier: PollTier): TierInfo {
  if (tier === 'paused') return { tier, intervalMin: null, deepEveryMin: null };
  return { tier, ...TABLE[tier] };
}

/** Automatic tier from age; an override always wins. Unknown publish date counts as warm. */
export function tierFor(publishedAt: string | null, override: PollTier | null, now: Date): TierInfo {
  if (override) return tierInfo(override);
  if (!publishedAt) return tierInfo('warm');
  const ageDays = (now.getTime() - new Date(publishedAt).getTime()) / (DAY * 60_000);
  if (ageDays < 3) return tierInfo('hot');
  if (ageDays < 30) return tierInfo('warm');
  if (ageDays < 365) return tierInfo('cold');
  return tierInfo('frozen');
}

/** Roughly one API unit per poll (one page of threads). */
export function unitsPerDay(info: TierInfo): number {
  return info.intervalMin === null ? 0 : (24 * 60) / info.intervalMin;
}
