import type { EventBus, Repo } from '../contracts.js';

export interface SnoozeWakerDeps {
  repo: Repo;
  bus: EventBus;
  intervalMs?: number;
}

export interface SnoozeWaker {
  start(): void;
  stop(): void;
  /** Wake everything that is due now; emits inbox.changed when something woke. Returns the woken ids. */
  sweep(): string[];
}

/**
 * Periodically ends snoozes whose time has passed. Wake times are stored on the comments (repo.wakeSnoozed
 * compares against the repo's clock), so a restart loses nothing: the first sweep catches up.
 */
export function createSnoozeWaker(deps: SnoozeWakerDeps): SnoozeWaker {
  let timer: ReturnType<typeof setInterval> | null = null;

  function sweep(): string[] {
    const { woken, counts } = deps.repo.wakeSnoozed();
    if (woken.length > 0) deps.bus.emit({ type: 'inbox.changed', counts, addedIds: woken, changedIds: [] });
    return woken;
  }

  const safeSweep = () => {
    try {
      sweep();
    } catch (e) {
      console.warn('Snooze sweep failed:', e instanceof Error ? e.message : e);
    }
  };

  return {
    sweep,
    start() {
      if (timer) return;
      timer = setInterval(safeSweep, deps.intervalMs ?? 15_000);
      timer.unref?.();
      safeSweep();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
