import type { QuotaTracker, Repo, Scheduler, StoredSettings, SyncEngine } from '../contracts.js';

export interface SchedulerDeps {
  repo: Repo;
  engine: SyncEngine;
  quota: QuotaTracker;
  getSettings: () => StoredSettings;
  hasApiKey: () => boolean;
  clock?: () => Date;
  tickMs?: number;
}

/**
 * Wakes every minute and, if polling is enabled, a key exists and quota allows, asks the engine for a
 * background poll run. The engine decides what is actually due (videos, own-channel feeds, hourly
 * membership refreshes) and returns immediately when nothing is.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler & { tick(): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    if (!deps.getSettings().pollEnabled || !deps.hasApiKey() || !deps.quota.canPoll()) return;
    if (deps.engine.status().running) return;
    ticking = true;
    try {
      await deps.engine.run({ trigger: 'poll', scope: 'all' });
    } catch {
      /* engine records its own errors */
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), deps.tickMs ?? 60_000);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
