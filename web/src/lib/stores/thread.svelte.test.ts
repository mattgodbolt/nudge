import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadDetail } from '../../../../shared/types';
import { ThreadStore } from './thread.svelte';

const detail = (threadId: string, version: number): ThreadDetail => ({
  threadId,
  video: { id: 'v1', title: `Video v${version}`, thumbnailUrl: null } as ThreadDetail['video'],
  canReply: true,
  comments: [],
  totalReplyCount: version,
});

describe('ThreadStore', () => {
  let store: ThreadStore;
  let version: number;
  /** Requests not yet answered, oldest first; answer() resolves the oldest with the data as it was when asked. */
  let waiting: { id: string; body: ThreadDetail; resolve: (r: Response) => void }[];
  const answer = async () => {
    const w = waiting.shift()!;
    w.resolve(new Response(JSON.stringify(w.body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => {});
    await new Promise((r) => setTimeout(r, 0));
  };
  const fetches = () => waiting.length;

  beforeEach(() => {
    version = 1;
    waiting = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const id = decodeURIComponent(url.replace('/api/threads/', '').split('?')[0]!);
        return new Promise<Response>((resolve) => waiting.push({ id, body: detail(id, version), resolve }));
      }),
    );
    store = new ThreadStore();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows a cached thread at once and fetches an unseen one with a loading state', async () => {
    const p = store.show('t1');
    expect(store.current).toBeNull();
    expect(store.loading).toBe(true);
    await answer();
    await p;
    expect(store.current?.threadId).toBe('t1');
    expect(store.loading).toBe(false);
    void store.show('t1');
    expect(fetches()).toBe(0);
  });

  it('keeps the open thread on screen across a live update, then swaps in the fresh copy', async () => {
    void store.show('t1');
    await answer();
    const shown = store.current;
    version = 2;
    store.invalidate();
    // Re-showing the same thread (the list row changed identity) must not blank it.
    void store.show('t1');
    expect(store.current).toBe(shown);
    expect(store.loading).toBe(false);
    expect(fetches()).toBe(1); // one background refetch, not one per call
    await answer();
    expect(store.current?.totalReplyCount).toBe(2);
    expect(store.loading).toBe(false);
  });

  it('a live update refetches the open thread by itself', async () => {
    void store.show('t1');
    await answer();
    version = 2;
    store.invalidate();
    expect(fetches()).toBe(1);
    expect(store.current?.totalReplyCount).toBe(1);
    await answer();
    expect(store.current?.totalReplyCount).toBe(2);
  });

  it('a stale cached thread is shown at once when moving back to it, and refreshed', async () => {
    void store.show('t1');
    await answer();
    void store.show('t2');
    await answer();
    version = 2;
    store.invalidate(); // refetches t2, the one on screen
    await answer();
    void store.show('t1');
    expect(store.current?.threadId).toBe('t1');
    expect(store.current?.totalReplyCount).toBe(1);
    expect(store.loading).toBe(false);
    await answer();
    expect(store.current?.totalReplyCount).toBe(2);
  });

  it('a fetch already in flight when the server says things changed does not count as fresh', async () => {
    store.prefetch('t3');
    store.invalidate();
    await answer(); // the old answer lands
    version = 2;
    void store.show('t3');
    expect(store.current?.totalReplyCount).toBe(1); // shown (better than a blank) ...
    expect(fetches()).toBe(1); // ... but fetched again
    await answer();
    expect(store.current?.totalReplyCount).toBe(2);
  });

  it('a late answer for a thread no longer wanted does not replace the one on screen', async () => {
    void store.show('t1');
    void store.show('t2');
    await answer(); // t1 lands after the user moved on
    expect(store.current).toBeNull();
    await answer();
    expect(store.current?.threadId).toBe('t2');
  });
});
