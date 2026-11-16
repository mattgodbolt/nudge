import { describe, expect, it } from 'vitest';
import { shouldResyncOnReturn, STALE_AFTER_MS } from './resync.svelte';

describe('shouldResyncOnReturn', () => {
  it('resyncs only after the tab was hidden for a while', () => {
    expect(shouldResyncOnReturn(null, 10_000)).toBe(false);
    expect(shouldResyncOnReturn(1_000, 1_000 + STALE_AFTER_MS - 1)).toBe(false);
    expect(shouldResyncOnReturn(1_000, 1_000 + STALE_AFTER_MS)).toBe(true);
  });
});
