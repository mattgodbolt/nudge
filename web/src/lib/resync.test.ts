import { describe, expect, it } from 'vitest';
import { entryScript, newBuildAvailable, shouldResyncOnReturn, STALE_AFTER_MS } from './resync.svelte';

describe('shouldResyncOnReturn', () => {
  it('resyncs only after the tab was hidden for a while', () => {
    expect(shouldResyncOnReturn(null, 10_000)).toBe(false);
    expect(shouldResyncOnReturn(1_000, 1_000 + STALE_AFTER_MS - 1)).toBe(false);
    expect(shouldResyncOnReturn(1_000, 1_000 + STALE_AFTER_MS)).toBe(true);
  });
});

describe('newBuildAvailable', () => {
  const page = (hash: string) =>
    `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script></head></html>`;
  it('extracts the entry script', () => {
    expect(entryScript(page('CnGpmrSF'))).toBe('/assets/index-CnGpmrSF.js');
    expect(entryScript('<script type="module" src="/src/main.ts"></script>')).toBeNull();
  });
  it('detects a different build, and nothing when unchanged or unknown', () => {
    expect(newBuildAvailable(page('new'), '/assets/index-old.js')).toBe(true);
    expect(newBuildAvailable(page('same'), '/assets/index-same.js')).toBe(false);
    expect(newBuildAvailable('<html>not our page</html>', '/assets/index-old.js')).toBe(false);
    expect(newBuildAvailable(page('new'), null)).toBe(false);
  });
});
