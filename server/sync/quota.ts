import type { QuotaTracker, Repo, StoredSettings } from '../contracts.js';
import type { QuotaDTO } from '../../shared/types.js';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in Pacific time: YouTube's quota resets at Pacific midnight. */
export function pacificDay(d: Date): string {
  return fmt.format(d);
}

/** First instant (to the second) of the next Pacific day. */
export function nextPacificMidnight(d: Date): Date {
  const day = pacificDay(d);
  let lo = Math.floor(d.getTime() / 1000); // work in whole seconds
  let hi = lo + 25 * 3600; // longest possible Pacific day
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pacificDay(new Date(mid * 1000)) === day) lo = mid;
    else hi = mid;
  }
  return new Date(hi * 1000);
}

export interface QuotaDeps {
  repo: Repo;
  getSettings: () => StoredSettings;
  clock?: () => Date;
}

export function createQuotaTracker(deps: QuotaDeps): QuotaTracker {
  const clock = deps.clock ?? (() => new Date());
  let blockedUntil: Date | null = null;

  const activeBlock = (): Date | null => {
    if (blockedUntil && clock().getTime() >= blockedUntil.getTime()) blockedUntil = null;
    return blockedUntil;
  };
  const dayPt = () => pacificDay(clock());
  const used = () => deps.repo.quotaUsed(dayPt());

  return {
    dayPt,
    charge(endpoint, units) {
      deps.repo.recordQuota(dayPt(), endpoint, units);
    },
    used,
    snapshot(): QuotaDTO {
      const s = deps.getSettings();
      return {
        dayPt: dayPt(),
        used: used(),
        budget: s.dailyQuotaBudget,
        reserve: s.manualReserve,
        blockedUntil: activeBlock()?.toISOString() ?? null,
      };
    },
    canPoll() {
      const s = deps.getSettings();
      return !activeBlock() && used() < s.dailyQuotaBudget - s.manualReserve;
    },
    canManual() {
      return !activeBlock() && used() < deps.getSettings().dailyQuotaBudget;
    },
    blockUntilNextDay() {
      blockedUntil = nextPacificMidnight(clock());
    },
  };
}
