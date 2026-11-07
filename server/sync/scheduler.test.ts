import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from './scheduler.js';
import type { QuotaTracker, StoredSettings, SyncEngine } from '../contracts.js';

function setup(o: { poll?: boolean; key?: boolean; canPoll?: boolean; running?: boolean } = {}) {
  const run = vi.fn(async () => ({
    id: 1,
    trigger: 'poll',
    startedAt: '',
    finishedAt: '',
    units: 0,
    videos: 0,
    newComments: 0,
    error: null,
  }));
  const engine = { run, status: () => ({ running: o.running ?? false }) } as unknown as SyncEngine;
  const scheduler = createScheduler({
    repo: {} as never,
    engine,
    quota: { canPoll: () => o.canPoll ?? true } as unknown as QuotaTracker,
    getSettings: () => ({ pollEnabled: o.poll ?? true }) as StoredSettings,
    hasApiKey: () => o.key ?? true,
    tickMs: 1000,
  });
  return { run, scheduler };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('requests a poll run when enabled, keyed and within quota', async () => {
    const { run, scheduler } = setup();
    await scheduler.tick();
    expect(run).toHaveBeenCalledWith({ trigger: 'poll', scope: 'all' });
  });
  it.each([
    ['polling disabled', { poll: false }],
    ['no API key', { key: false }],
    ['quota exhausted', { canPoll: false }],
    ['a run already in progress', { running: true }],
  ])('does nothing with %s', async (_n, o) => {
    const { run, scheduler } = setup(o);
    await scheduler.tick();
    expect(run).not.toHaveBeenCalled();
  });
  it('ticks on an interval until stopped, and start() is idempotent', async () => {
    vi.useFakeTimers();
    const { run, scheduler } = setup();
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(3); // immediate + 2 intervals
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('swallows engine failures', async () => {
    const { run, scheduler } = setup();
    run.mockRejectedValueOnce(new Error('x'));
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
