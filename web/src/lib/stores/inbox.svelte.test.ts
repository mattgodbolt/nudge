import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentDTO, Counts, InboxItem } from '../../../../shared/types';
import { InboxStore } from './inbox.svelte';
import { toasts } from './toasts.svelte';

function item(n: number, state: CommentDTO['state'] = 'inbox'): InboxItem {
  const id = `c${n}`;
  return {
    comment: {
      id,
      threadId: `t${n}`,
      parentId: null,
      videoId: 'v1',
      authorName: `Author ${n}`,
      authorChannelId: null,
      authorAvatarUrl: null,
      textHtml: `hello ${n}`,
      textPlain: `hello ${n}`,
      likeCount: 0,
      // Higher n = older, matching the server's published_at DESC order.
      publishedAt: new Date(Date.UTC(2025, 0, 1, 0, 100 - n)).toISOString(),
      updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 100 - n)).toISOString(),
      isOwn: false,
      state,
      stateSource: 'sync',
      permalink: `https://www.youtube.com/watch?v=v1&lc=${id}`,
    },
    video: { id: 'v1', title: 'Video', thumbnailUrl: null },
    parent: null,
    threadReplyCount: 0,
    hasDraft: false,
  };
}

const counts = (inbox: number, done: number): Counts => ({ inbox, done, all: inbox + done, bySource: {} });
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('InboxStore', () => {
  let store: InboxStore;
  let fetchMock: ReturnType<typeof vi.fn>;
  let triageResponse: () => Promise<Response>;

  beforeEach(async () => {
    toasts.items = [];
    triageResponse = () => json({ actionId: 7, changes: [], counts: counts(3, 1) });
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/inbox')) {
        return json({ items: [1, 2, 3, 4].map((n) => item(n)), nextCursor: null, total: 4 });
      }
      if (url === '/api/triage' && init?.method === 'POST') return triageResponse();
      if (/\/api\/triage\/\d+\/undo/.test(url)) return json({ actionId: 7, changes: [], counts: counts(4, 0) });
      return json({ error: 'nope', code: 'x' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    store = new InboxStore();
    store.counts = counts(4, 0);
    await store.load();
  });
  afterEach(() => vi.unstubAllGlobals());

  const ids = () => store.items.map((i) => i.comment.id);

  it('loads and selects the first item', () => {
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(store.selectedId).toBe('c1');
  });

  it('moves selection and clamps', () => {
    store.move(1);
    store.move(1);
    expect(store.selectedId).toBe('c3');
    store.move(10);
    expect(store.selectedId).toBe('c4');
    store.move(-10);
    expect(store.selectedId).toBe('c1');
  });

  it('optimistically removes the item, advances selection and adjusts counts before the server answers', async () => {
    let release!: () => void;
    triageResponse = () =>
      new Promise((res) => {
        release = () =>
          res(new Response(JSON.stringify({ actionId: 7, changes: [], counts: counts(3, 1) }), { status: 200 }));
      });
    store.move(1); // c2
    const p = store.triage('done');
    // Synchronously visible, request not yet resolved.
    expect(ids()).toEqual(['c1', 'c3', 'c4']);
    expect(store.selectedId).toBe('c3');
    expect(store.counts.inbox).toBe(3);
    expect(store.counts.done).toBe(1);
    release();
    expect(await p).toBe(true);
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/triage')!;
    expect(JSON.parse(call[1].body)).toEqual({ commentIds: ['c2'], to: 'done' });
    expect(call[1].headers['X-Youtubey']).toBe('1');
    expect(toasts.items.at(-1)?.action?.label).toBe('Undo');
  });

  it('selects the previous item when the last one is triaged', async () => {
    store.move(10);
    await store.triage('done');
    expect(ids()).toEqual(['c1', 'c2', 'c3']);
    expect(store.selectedId).toBe('c3');
  });

  it('rolls back items, selection and counts when the request fails', async () => {
    triageResponse = () => json({ error: 'boom', code: 'internal' }, 500);
    store.move(1);
    const ok = await store.triage('done');
    expect(ok).toBe(false);
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(store.selectedId).toBe('c2');
    expect(store.counts).toMatchObject({ inbox: 4, done: 0 });
    expect(toasts.items.at(-1)?.kind).toBe('error');
    // Failed actions must not be undoable.
    await store.undo();
    expect(fetchMock.mock.calls.some((c) => /undo/.test(c[0]))).toBe(false);
  });

  it('rolls back on a network failure', async () => {
    triageResponse = () => Promise.reject(new TypeError('Failed to fetch'));
    await store.triage('done');
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('undo restores the item in sorted position and selects it', async () => {
    store.move(1);
    await store.triage('done');
    expect(ids()).toEqual(['c1', 'c3', 'c4']);
    const p = store.undo();
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']); // optimistic
    expect(store.selectedId).toBe('c2');
    expect(await p).toBe(true);
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/triage/7/undo')).toBe(true);
    expect(store.counts.inbox).toBe(4);
  });

  it('triages the multi-selection as one action', async () => {
    store.toggleSelect('c1');
    store.toggleSelect('c3');
    await store.triage('done');
    expect(ids()).toEqual(['c2', 'c4']);
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/triage')!;
    expect(JSON.parse(call[1].body).commentIds.sort()).toEqual(['c1', 'c3']);
    expect(store.selectedIds.size).toBe(0);
  });

  it('keeps items in place (state updated) in the All view', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === '/api/triage' && init?.method === 'POST'
        ? json({ actionId: 9, changes: [], counts: counts(3, 1) })
        : json({ items: [item(1), item(2)], nextCursor: null, total: 2 }),
    );
    await store.configure('all', {});
    await store.triage('done');
    expect(ids()).toEqual(['c1', 'c2']);
    expect(store.items[0]!.comment.state).toBe('done');
  });

  it('shows a pill instead of moving the list when the user is mid-list', async () => {
    store.move(2);
    store.applyServerEvent({ type: 'inbox.changed', counts: counts(5, 0), addedIds: ['c9'], changedIds: [] });
    expect(store.pendingCount).toBe(1);
    expect(store.counts.inbox).toBe(5);
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
  });
});
