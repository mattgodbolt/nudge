import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentDTO, Counts, InboxItem } from '../../../../shared/types';
import { InboxStore, compareItems } from './inbox.svelte';
import { toasts } from './toasts.svelte';
import { decisions } from '../decisions';

function item(n: number, state: CommentDTO['state'] = 'inbox'): InboxItem {
  const id = `c${n}`;
  return {
    item: {
      id,
      provider: 'youtube',
      kind: 'comment',
      title: null,
      author: `Author ${n}`,
      authorAvatarUrl: null,
      isOwn: false,
      url: null,
      containerKey: 'v1',
      containerTitle: 'Video',
      containerUrl: null,
      sourceState: null,
      reason: null,
      muted: false,
    },
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
    arrivedAt: '2025-01-01T00:00:00.000Z',
    threadReplyCount: 0,
    hasDraft: false,
    snoozedUntil: null,
    wokeAt: null,
    snoozeWhy: null,
    snoozeBucket: null,
    snoozeUntilActivity: false,
    snoozedAt: null,
    wakeCause: null,
    snoozeNag: null,
    suggestion: null,
  };
}

const counts = (inbox: number, done: number): Counts => ({
  inbox,
  done,
  all: inbox + done,
  snoozed: 0,
  bySource: {},
  byFeed: {},
  byRepo: {},
  todos: 0,
});
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

  it('reports the list as it was seen when an action is taken, before it changes', async () => {
    const decide = vi.spyOn(decisions, 'decide');
    store.move(2); // c3
    await store.triage('done');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toEqual({
      action: 'done',
      view: 'inbox',
      list: ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, passable: true })),
      targets: ['c3'],
    });
    decide.mockRestore();
  });

  it('dismisses with the dismissed target, records it as that decision, and undo brings the row back', async () => {
    const decide = vi.spyOn(decisions, 'decide');
    store.move(1); // c2
    await store.triage('dismissed');
    const call = fetchMock.mock.calls.find(([u]) => u === '/api/triage')!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ commentIds: ['c2'], to: 'dismissed' });
    expect(decide.mock.calls[0]![0]).toMatchObject({ action: 'dismissed', targets: ['c2'] });
    expect(ids()).not.toContain('c2');
    expect(toasts.items.at(-1)?.message).toContain('Marked no action needed');
    await store.undo();
    expect(ids()).toContain('c2');
    decide.mockRestore();
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
    expect(call[1].headers['X-Nudge']).toBe('1');
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

  it("a toast's Undo undoes that toast's action, not the newest one", async () => {
    let next = 20;
    triageResponse = () => json({ actionId: next++, changes: [], counts: counts(3, 1) });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/inbox')) return json({ items: [1, 2, 3, 4].map((n) => item(n)), nextCursor: null });
      if (url === '/api/triage' && init?.method === 'POST') return triageResponse();
      if (/\/api\/triage\/\d+\/undo/.test(url)) return json({ actionId: 1, changes: [], counts: counts(3, 1) });
      return json({ error: 'nope', code: 'x' }, 404);
    });
    await store.triage('done', ['c1']); // action 20
    await store.triage('done', ['c2']); // action 21
    expect(ids()).toEqual(['c3', 'c4']);
    const first = toasts.items[0]!;
    expect(first.message).toContain('Marked done');
    first.action!.run();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/api/triage/20/undo')).toBe(true));
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/triage/21/undo')).toBe(false);
    expect(ids()).toEqual(['c1', 'c3', 'c4']);
    // The newer action is still on the stack for z.
    expect(store.undoDepth).toBe(1);
    await store.undo();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/triage/21/undo')).toBe(true);
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('undoing a request that then fails leaves the list as it was before, with one error', async () => {
    let fail!: () => void;
    triageResponse = () =>
      new Promise((res) => {
        fail = () => res(new Response(JSON.stringify({ error: 'boom', code: 'internal' }), { status: 500 }));
      });
    store.move(1); // c2
    const p = store.triage('done');
    expect(ids()).toEqual(['c1', 'c3', 'c4']);
    const u = store.undo();
    fail();
    expect(await p).toBe(false);
    expect(await u).toBe(false);
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(store.items.find((i) => i.comment.id === 'c2')!.comment.state).toBe('inbox');
    expect(store.counts).toMatchObject({ inbox: 4, done: 0 });
    expect(toasts.items.filter((t) => t.kind === 'error')).toHaveLength(1);
    expect(fetchMock.mock.calls.some((c) => /undo/.test(c[0]))).toBe(false);
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

  it('queries with the suggestion filter, and a selection never outlives the filter it was made under', async () => {
    store.toggleSelect('c1');
    store.toggleSelect('c2');
    expect(store.selectedCount).toBe(2);
    await store.configure('inbox', { suggestion: 'matt' });
    const urls = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith('/api/inbox'));
    expect(urls.at(-1)).toContain('suggestion=matt');
    expect(store.selectedIds.size).toBe(0);
  });

  it('acts only on selected rows that are still on screen', async () => {
    // An id left over in the set (say, from before the list changed) is never sent.
    store.selectedIds = new Set(['c2', 'gone']);
    expect(store.selectedCount).toBe(1);
    expect(store.targetIds()).toEqual(['c2']);
    store.selectedIds = new Set(['gone']);
    expect(store.selectedCount).toBe(0);
    expect(store.targetIds()).toEqual(['c1']); // nothing visible selected: the cursor row
  });

  describe('a deep link (?c=) to an item beyond the first page', () => {
    const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => item(from + k));
    beforeEach(() => {
      // Three pages of three; c9 is on the last. c99 is not in this list at all.
      fetchMock.mockImplementation((url: string) => {
        if (!url.startsWith('/api/inbox')) return json({ error: 'nope', code: 'x' }, 404);
        const u = new URL(url, 'http://x');
        const asked = u.searchParams.getAll('ids');
        if (asked.length)
          return json({ items: page(1, 9).filter((i) => asked.includes(i.comment.id)), nextCursor: null });
        const cursor = u.searchParams.get('cursor');
        return cursor === 'p3'
          ? json({ items: page(7, 9), nextCursor: null, total: 9 })
          : cursor === 'p2'
            ? json({ items: page(4, 6), nextCursor: 'p3', total: 9 })
            : json({ items: page(1, 3), nextCursor: 'p2', total: 9 });
      });
    });

    it('loads on until it reaches the item, and selects it', async () => {
      await store.configure('all', {}, 'c9');
      await vi.waitFor(() => expect(store.selectedId).toBe('c9'));
      expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    });

    it('does not page through the whole list for an item that is not in it', async () => {
      await store.configure('all', {}, 'c99');
      await new Promise((r) => setTimeout(r, 20));
      expect(store.selectedId).toBe('c1');
      expect(ids()).toEqual(['c1', 'c2', 'c3']);
    });
  });

  it('selectAllMatching loads the remaining pages, then selects everything the filter matches', async () => {
    const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => item(from + k));
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/inbox')) {
        return url.includes('cursor=p2')
          ? json({ items: page(4, 6), nextCursor: null, total: 6 })
          : json({ items: page(1, 3), nextCursor: 'p2', total: 6 });
      }
      return json({ error: 'nope', code: 'x' }, 404);
    });
    await store.configure('inbox', { suggestion: 'act' });
    store.selectAll();
    expect(store.selectedCount).toBe(3);
    await store.selectAllMatching();
    expect(ids()).toHaveLength(6);
    expect(store.selectedCount).toBe(6);
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

  describe('rows changed elsewhere (another device, a sync, your own reply upstream)', () => {
    // The server's answer for `ids=`: those that still belong in the inbox, c2 having been finished elsewhere.
    const serve = (gone: string[], edited: Record<string, string> = {}) =>
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/triage' && init?.method === 'POST') return triageResponse();
        if (!url.startsWith('/api/inbox')) return json({ error: 'nope', code: 'x' }, 404);
        const asked = new URL(url, 'http://x').searchParams.getAll('ids');
        const all = [1, 2, 3, 4].map((n) => item(n));
        const rows = asked.length ? all.filter((i) => asked.includes(i.comment.id)) : all;
        const left = rows
          .filter((i) => !gone.includes(i.comment.id))
          .map((i) =>
            edited[i.comment.id] ? { ...i, comment: { ...i.comment, textPlain: edited[i.comment.id]! } } : i,
          );
        return json({ items: left, nextCursor: null, total: left.length });
      });
    const changed = (changedIds: string[]) =>
      store.applyServerEvent({ type: 'inbox.changed', counts: counts(3, 1), addedIds: [], changedIds });
    const inboxUrls = () => fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith('/api/inbox'));

    it('are updated or removed in place wherever the cursor is, and the cursor stays put', async () => {
      serve(['c2'], { c4: 'edited' });
      store.move(2); // c3
      changed(['c2', 'c4', 'not-loaded']);
      await vi.waitFor(() => expect(ids()).toEqual(['c1', 'c3', 'c4']));
      expect(store.items[2]!.comment.textPlain).toBe('edited');
      expect(store.selectedId).toBe('c3');
      // Only the loaded rows that changed are asked about.
      expect(inboxUrls().at(-1)).toMatch(/ids=c2&ids=c4$/);
      expect(store.pendingCount).toBe(0);
    });

    it('when the row under the cursor is finished elsewhere, the cursor moves to the next row', async () => {
      serve(['c3']);
      store.move(2); // c3
      changed(['c3']);
      await vi.waitFor(() => expect(ids()).toEqual(['c1', 'c2', 'c4']));
      expect(store.selectedId).toBe('c4');
      expect(store.total).toBe(3);
    });

    it('leaves the row being replied to in place while the composer is open', async () => {
      serve(['c3', 'c4']);
      store.move(2); // c3
      store.composing = true;
      changed(['c3', 'c4']);
      await vi.waitFor(() => expect(ids()).toEqual(['c1', 'c2', 'c3']));
      expect(store.selectedId).toBe('c3');
    });

    it('does not touch a row whose own action is still in flight', async () => {
      let release!: () => void;
      triageResponse = () =>
        new Promise((res) => {
          release = () =>
            res(new Response(JSON.stringify({ actionId: 7, changes: [], counts: counts(3, 1) }), { status: 200 }));
        });
      serve([]);
      store.move(1); // c2
      const p = store.triage('done');
      changed(['c2', 'c3']);
      await vi.waitFor(() => expect(inboxUrls().at(-1)).toMatch(/ids=c3$/));
      expect(ids()).toEqual(['c1', 'c3', 'c4']);
      release();
      await p;
    });

    it('a late event racing an undo does not drop the row the undo brought back', async () => {
      await store.triage('done', ['c2']);
      const resp = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const gates: { undo?: () => void; patch?: () => void } = {};
      fetchMock.mockImplementation((url: string) => {
        if (/\/api\/triage\/\d+\/undo/.test(url))
          return new Promise((r) => (gates.undo = () => r(resp({ actionId: 7, changes: [], counts: counts(4, 0) }))));
        // Asked before the undo lands, the server still has c2 as done: not in the inbox.
        if (url.includes('ids='))
          return new Promise((r) => (gates.patch = () => r(resp({ items: [], nextCursor: null, total: 0 }))));
        return json({ error: 'nope', code: 'x' }, 404);
      });
      const u = store.undo();
      expect(ids()).toContain('c2');
      changed(['c2']); // the triage's own event, arriving late
      await vi.waitFor(() => expect(gates.undo && gates.patch).toBeTruthy());
      gates.undo!();
      expect(await u).toBe(true);
      gates.patch!();
      await new Promise((r) => setTimeout(r, 0));
      expect(ids()).toContain('c2');
    });
  });

  it('a refresh while an undo is on its way keeps the row the undo brought back', async () => {
    await store.triage('done', ['c2']);
    const gate: { open?: () => void } = {};
    fetchMock.mockImplementation((url: string) => {
      if (/\/api\/triage\/\d+\/undo/.test(url))
        return new Promise((r) => {
          gate.open = () =>
            r(new Response(JSON.stringify({ actionId: 7, changes: [], counts: counts(4, 0) }), { status: 200 }));
        });
      // The server has not heard of the undo yet: c2 is still done.
      if (url.startsWith('/api/inbox')) return json({ items: [1, 3, 4].map((n) => item(n)), nextCursor: null });
      return json({ error: 'nope', code: 'x' }, 404);
    });
    const u = store.undo();
    await store.refreshTop();
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    await vi.waitFor(() => expect(gate.open).toBeDefined());
    gate.open!();
    expect(await u).toBe(true);
  });

  it('keeps every id once when a refreshed first page repeats one or overlaps the tail', async () => {
    const dup = item(2);
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/inbox')
        ? json({ items: [item(9), item(1), dup, item(2)], nextCursor: 'x', total: 5 })
        : json({ error: 'nope', code: 'x' }, 404),
    );
    await store.refreshTop();
    expect(ids().length).toBe(new Set(ids()).size);
    expect(ids().slice(0, 3)).toEqual(['c9', 'c1', 'c2']);
  });
});

describe('InboxStore snooze', () => {
  let store: InboxStore;
  let fetchMock: ReturnType<typeof vi.fn>;
  let snoozeActionId: number | null;

  const snoozed = (n: number, until = '2099-01-01T08:00:00.000Z'): InboxItem => ({ ...item(n), snoozedUntil: until });
  const full = (inboxN: number, snoozedN: number): Counts => ({
    inbox: inboxN,
    done: 0,
    all: inboxN + snoozedN,
    snoozed: snoozedN,
    bySource: {},
    byFeed: {},
    byRepo: {},
    todos: 0,
  });
  const bodies = (path: string) =>
    fetchMock.mock.calls.filter((c) => c[0] === path).map((c) => JSON.parse(c[1].body as string));

  beforeEach(() => {
    toasts.items = [];
    snoozeActionId = 11;
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/inbox')) {
        return json({ items: [1, 2, 3, 4].map((n) => item(n)), nextCursor: null, total: 4 });
      }
      if (url === '/api/snooze') return json({ actionId: snoozeActionId, changes: [], counts: full(3, 1) });
      if (url === '/api/snooze/11/undo') return json({ actionId: 11, changes: [], counts: full(4, 0) });
      return json({ error: 'nope', code: 'x' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    store = new InboxStore();
    store.counts = full(4, 0);
  });
  afterEach(() => vi.unstubAllGlobals());

  const ids = () => store.items.map((i) => i.comment.id);
  const load = async () => {
    await store.load();
  };

  it('snoozing removes the row from the inbox, moves the cursor and shifts counts', async () => {
    await load();
    store.move(1); // c2
    const until = new Date('2099-01-01T08:00:00.000Z');
    const p = store.snooze(until, undefined, 'Thu 8:00 AM');
    expect(ids()).toEqual(['c1', 'c3', 'c4']);
    expect(store.selectedId).toBe('c3');
    expect(store.counts).toMatchObject({ inbox: 3, snoozed: 1 });
    expect(await p).toBe(true);
    expect(bodies('/api/snooze')).toEqual([{ commentIds: ['c2'], until: until.toISOString() }]);
    const toast = toasts.items.at(-1)!;
    expect(toast.message).toBe('Snoozed until Thu 8:00 AM · z to undo');
    expect(toast.action?.label).toBe('Undo');
  });

  it('sends the why with the snooze, once for every selected item, and sends nothing when there is none', async () => {
    await load();
    store.toggleSelect('c1');
    store.toggleSelect('c3');
    const until = new Date('2099-01-01T08:00:00.000Z');
    await store.snooze(until, undefined, 'Thu 8:00 AM', '  review the fix  ');
    expect(bodies('/api/snooze')).toEqual([
      { commentIds: expect.any(Array), until: until.toISOString(), why: 'review the fix' },
    ]);
    await store.snooze(until, ['c2'], 'Thu 8:00 AM', '   ');
    expect(bodies('/api/snooze')[1]).toEqual({ commentIds: ['c2'], until: until.toISOString() });
  });

  it('sends the bucket and until-activity with the snooze (one choice for the whole selection), and shows them at once', async () => {
    await load();
    store.toggleSelect('c1');
    store.toggleSelect('c3');
    const until = new Date('2099-01-08T08:00:00.000Z');
    await store.snooze(until, undefined, 'activity', 'wait for them', {
      bucket: 'waiting_on_them',
      untilActivity: true,
    });
    expect(bodies('/api/snooze')).toEqual([
      {
        commentIds: expect.any(Array),
        until: until.toISOString(),
        why: 'wait for them',
        bucket: 'waiting_on_them',
        untilActivity: true,
      },
    ]);
    expect(bodies('/api/snooze')[0].commentIds.sort()).toEqual(['c1', 'c3']);
    await store.snooze(until, ['c2'], 'Thu', undefined, { bucket: 'in_flight' });
    expect(bodies('/api/snooze')[1]).toEqual({ commentIds: ['c2'], until: until.toISOString(), bucket: 'in_flight' });
  });

  it("snooze again keeps each item's bucket and words, with that bucket's own follow-up, and nothing for items that did not nag", async () => {
    const nag = (n: number, bucket: 'waiting_on_them' | 'in_flight', why: string | null): InboxItem => ({
      ...item(n),
      snoozeBucket: bucket,
      snoozeWhy: why,
      snoozeNag: { bucket, days: 7 },
    });
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/inbox')
        ? json({
            items: [nag(1, 'waiting_on_them', 'x'), nag(2, 'in_flight', null), item(3)],
            nextCursor: null,
            total: 3,
          })
        : json({ actionId: 11, changes: [], counts: full(1, 2) }),
    );
    await load();
    ['c1', 'c2', 'c3'].forEach((id) => store.toggleSelect(id));
    expect(await store.snoozeAgain()).toBe(true);
    const sent = bodies('/api/snooze');
    expect(sent.map((b) => [b.commentIds, b.bucket, b.untilActivity, b.why])).toEqual([
      [['c1'], 'waiting_on_them', true, 'x'],
      [['c2'], 'in_flight', true, undefined],
    ]);
    const days = (b: { until: string }) => Math.round((Date.parse(b.until) - Date.now()) / 86_400_000);
    expect(sent.map(days)).toEqual([7, 7]);
  });

  it('snoozes the multi-selection as one action', async () => {
    await load();
    store.toggleSelect('c1');
    store.toggleSelect('c3');
    await store.snooze(new Date('2099-01-01T08:00:00.000Z'));
    expect(ids()).toEqual(['c2', 'c4']);
    expect(bodies('/api/snooze')[0].commentIds.sort()).toEqual(['c1', 'c3']);
    expect(store.selectedIds.size).toBe(0);
  });

  it('undo calls the snooze undo endpoint and restores the row', async () => {
    await load();
    await store.snooze(new Date('2099-01-01T08:00:00.000Z'));
    expect(ids()).toEqual(['c2', 'c3', 'c4']);
    expect(await store.undo()).toBe(true);
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/snooze/11/undo')).toBe(true);
    expect(fetchMock.mock.calls.some((c) => /triage/.test(c[0]))).toBe(false);
    expect(store.counts).toMatchObject({ inbox: 4, snoozed: 0 });
  });

  it('rolls back a failed snooze and leaves nothing to undo', async () => {
    await load();
    fetchMock.mockImplementation(() => json({ error: 'x', code: 'bad_until' }, 400));
    expect(await store.snooze(new Date('2099-01-01T08:00:00.000Z'))).toBe(false);
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(store.counts).toMatchObject({ inbox: 4, snoozed: 0 });
    expect(store.undoDepth).toBe(0);
    expect(toasts.items.at(-1)?.kind).toBe('error');
  });

  it('does not snooze comments that are not in the inbox state', async () => {
    fetchMock.mockImplementation(() => json({ items: [item(1, 'done')], nextCursor: null, total: 1 }));
    await store.configure('all', {});
    expect(await store.snooze(new Date('2099-01-01T08:00:00.000Z'))).toBe(false);
    expect(bodies('/api/snooze')).toEqual([]);
  });

  it('unsnoozing in the Snoozed view removes the row via POST /api/snooze {until:null}', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/snooze'
        ? json({ actionId: 11, changes: [], counts: full(4, 1) })
        : json({ items: [snoozed(1), snoozed(2)], nextCursor: null, total: 2 }),
    );
    await store.configure('snoozed', {});
    expect(ids()).toEqual(['c1', 'c2']);
    await store.unsnooze();
    expect(ids()).toEqual(['c2']);
    expect(bodies('/api/snooze')).toEqual([{ commentIds: ['c1'], until: null }]);
    expect(toasts.items.at(-1)?.message).toBe('Unsnoozed · z to undo');
  });

  it('keeps a snoozed row in the All view but updates it', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/snooze'
        ? json({ actionId: 11, changes: [], counts: full(3, 1) })
        : json({ items: [item(1), item(2)], nextCursor: null, total: 2 }),
    );
    await store.configure('all', {});
    await store.snooze(new Date('2099-01-01T08:00:00.000Z'));
    expect(ids()).toEqual(['c1', 'c2']);
    expect(store.items[0]!.snoozedUntil).toBe('2099-01-01T08:00:00.000Z');
  });

  it('sorts woken items first using wokeAt', () => {
    const woken = { ...item(4), wokeAt: '2026-01-01T00:00:00.000Z' };
    expect([item(1), woken].sort(compareItems).map((i) => i.comment.id)).toEqual(['c4', 'c1']);
  });
});

describe('compareItems', () => {
  const mk = (
    id: string,
    publishedAt: string,
    arrivedAt: string,
    provider: 'youtube' | 'github' | 'todo' = 'youtube',
  ) => {
    const base = item(1);
    return {
      ...base,
      arrivedAt,
      item: { ...base.item, provider },
      comment: { ...base.comment, id, publishedAt },
    };
  };
  const a = mk('a', '2025-01-03T00:00:00Z', '2025-02-01T00:00:00Z', 'youtube');
  const b = mk('b', '2025-01-02T00:00:00Z', '2025-03-01T00:00:00Z', 'github');
  const c = mk('c', '2025-01-01T00:00:00Z', '2025-01-15T00:00:00Z', 'todo');
  const sorted = (order: Parameters<typeof compareItems>[2]) =>
    [a, b, c].sort((x, y) => compareItems(x, y, order)).map((i) => i.comment.id);
  it('sorts each way the server does', () => {
    expect(sorted('newest')).toEqual(['a', 'b', 'c']);
    expect(sorted('oldest')).toEqual(['c', 'b', 'a']);
    expect(sorted('arrived')).toEqual(['b', 'a', 'c']);
    expect(sorted('source')).toEqual(['c', 'b', 'a']); // todo, github, youtube
  });
});
