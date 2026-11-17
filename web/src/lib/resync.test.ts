import { afterEach, describe, expect, it, vi } from 'vitest';
import { resync, shouldResyncOnReturn, STALE_AFTER_MS } from './resync.svelte';
import { app } from './stores/app.svelte';
import { inbox } from './stores/inbox.svelte';
import { thread } from './stores/thread.svelte';

describe('shouldResyncOnReturn', () => {
  it('resyncs only after the tab was hidden for a while', () => {
    expect(shouldResyncOnReturn(null, 10_000)).toBe(false);
    expect(shouldResyncOnReturn(1_000, 1_000 + STALE_AFTER_MS - 1)).toBe(false);
    expect(shouldResyncOnReturn(1_000, 1_000 + STALE_AFTER_MS)).toBe(true);
  });
});

describe('resync.run', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refetches the open thread along with counts and the list', async () => {
    const boot = vi.spyOn(app, 'boot').mockResolvedValue();
    const refreshTop = vi.spyOn(inbox, 'refreshTop').mockResolvedValue();
    const invalidate = vi.spyOn(thread, 'invalidate').mockImplementation(() => {});
    await resync.run();
    expect(boot).toHaveBeenCalledTimes(1);
    expect(refreshTop).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
