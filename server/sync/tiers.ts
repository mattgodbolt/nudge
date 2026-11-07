import type { PollTier } from '../../shared/types.js';

export interface TierInfo {
  tier: PollTier;
  /** Minutes between incremental polls (Infinity = never). */
  intervalMin: number;
  /** Minutes between full ("deep") scans (Infinity = never). */
  deepEveryMin: number;
}

const DAY = 24 * 60;
export const TIER_TABLE: Record<PollTier, Omit<TierInfo, 'tier'>> = {
  hot: { intervalMin: 10, deepEveryMin: 6 * 60 },
  warm: { intervalMin: 60, deepEveryMin: DAY },
  cold: { intervalMin: 12 * 60, deepEveryMin: 7 * DAY },
  frozen: { intervalMin: 48 * 60, deepEveryMin: 30 * DAY },
  paused: { intervalMin: Infinity, deepEveryMin: Infinity },
};

const ORDER: PollTier[] = ['hot', 'warm', 'cold', 'frozen'];

export function infoForTier(tier: PollTier): TierInfo {
  return { tier, ...TIER_TABLE[tier] };
}

/** Automatic tier from age, unless the user overrode it. Unknown publish dates are treated as cold. */
export function tierFor(publishedAt: string | null, override: PollTier | null, now: Date): TierInfo {
  if (override) return infoForTier(override);
  if (!publishedAt) return infoForTier('cold');
  const ageDays = (now.getTime() - new Date(publishedAt).getTime()) / (DAY * 60_000);
  if (ageDays < 3) return infoForTier('hot');
  if (ageDays < 30) return infoForTier('warm');
  if (ageDays < 365) return infoForTier('cold');
  return infoForTier('frozen');
}

/** One step colder (used for videos on an own channel, which are also covered by the channel feed). */
export function colder(info: TierInfo): TierInfo {
  const i = ORDER.indexOf(info.tier);
  if (i < 0) return info;
  return infoForTier(ORDER[Math.min(i + 1, ORDER.length - 1)] as PollTier);
}

export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}
