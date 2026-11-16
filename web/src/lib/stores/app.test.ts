import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  api: {
    bootstrap: vi.fn(async () => ({
      settings: { demo: false, theme: 'system' },
      capabilities: { canPost: false, postMode: 'handoff' },
      counts: { inbox: 0, done: 0, all: 0, snoozed: 0, bySource: {}, byFeed: {}, byRepo: {}, todos: 0 },
      sources: [],
      quota: null,
      sync: { running: false, lastRun: null },
      feeds: [],
      mutes: [],
    })),
  },
}));

import { app } from './app.svelte';
import { usage } from '../usage';

describe('app.boot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts the view the app opened on once, however often it boots again (every resync and reconnect)', async () => {
    vi.spyOn(usage, 'start').mockImplementation(() => {});
    const count = vi.spyOn(usage, 'count').mockImplementation(() => {});
    await app.boot();
    await app.boot();
    await app.boot();
    expect(count.mock.calls.filter(([k]) => k.startsWith('view.'))).toEqual([['view.inbox']]);
  });
});
