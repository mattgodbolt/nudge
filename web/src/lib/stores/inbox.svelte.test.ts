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
    labels: [],
    snoozedUntil: null,
    wokeAt: null,
    snoozeWhy: null,
    suggestion: null,
  };
}

const counts = (inbox: number, done: number): Counts => ({
  inbox,
  done,
  all: inbox + done,
  snoozed: 0,
  bySource: {},
  byLabel: {},
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
});

describe('InboxStore snooze and labels', () => {
  let store: InboxStore;
  let fetchMock: ReturnType<typeof vi.fn>;
  let snoozeActionId: number | null;

  const snoozed = (n: number, until = '2099-01-01T08:00:00.000Z'): InboxItem => ({ ...item(n), snoozedUntil: until });
  const full = (inboxN: number, snoozedN: number, byLabel: Record<number, number> = {}): Counts => ({
    inbox: inboxN,
    done: 0,
    all: inboxN + snoozedN,
    snoozed: snoozedN,
    bySource: {},
    byLabel,
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
      if (url === '/api/labels/apply') {
        const b = JSON.parse(init!.body as string) as { commentIds: string[]; add: number[] };
        return json({
          labels: Object.fromEntries(b.commentIds.map((id) => [id, b.add])),
          counts: full(4, 0, { 5: 2 }),
        });
      }
      return json({ error: 'nope', code: 'x' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    store = new InboxStore();
    store.counts = full(4, 0, { 5: 0 });
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

  it('queries with labelId and reloads when it changes', async () => {
    await load();
    await store.configure('all', { labelId: 5 });
    const urls = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith('/api/inbox'));
    expect(urls.at(-1)).toContain('view=all');
    expect(urls.at(-1)).toContain('labelId=5');
    const n = fetchMock.mock.calls.length;
    await store.configure('all', { labelId: 5 });
    expect(fetchMock.mock.calls.length).toBe(n); // unchanged: no reload
    await store.configure('all', { labelId: 6 });
    expect(fetchMock.mock.calls.length).toBe(n + 1);
  });

  it('applies labels in place, optimistically, then takes the server answer', async () => {
    await load();
    store.toggleSelect('c1');
    store.toggleSelect('c2');
    const p = store.applyLabels([5], []);
    expect(store.items[0]!.labels).toEqual([5]);
    expect(store.items[1]!.labels).toEqual([5]);
    expect(store.items[2]!.labels).toEqual([]);
    expect(store.counts.byLabel[5]).toBe(2);
    expect(await p).toBe(true);
    expect(ids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(bodies('/api/labels/apply')[0]).toEqual({ commentIds: expect.any(Array), add: [5], remove: [] });
    expect(store.counts.byLabel[5]).toBe(2);
  });

  it('quick add-then-remove ends with the label removed even though the first answer arrives later', async () => {
    await load();
    const answers: Array<(r: Response) => void> = [];
    const sent: unknown[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url !== '/api/labels/apply') return json({}, 404);
      sent.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((res) => answers.push(res));
    });
    const reply = (labels: number[]) =>
      new Response(JSON.stringify({ labels: { c1: labels }, counts: full(4, 0, { 5: labels.length }) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const add = store.applyLabels([5], [], ['c1']);
    const remove = store.applyLabels([], [5], ['c1']);
    expect(store.items[0]!.labels).toEqual([]); // optimistic: toggled on, then off
    await Promise.resolve();
    expect(sent).toHaveLength(1); // the second request waits for the first
    answers[0]!(reply([5]));
    await add;
    expect(store.items[0]!.labels).toEqual([]); // a stale answer must not resurrect the label
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    answers[1]!(reply([]));
    await remove;
    expect(store.items[0]!.labels).toEqual([]);
    expect(sent).toEqual([
      { commentIds: ['c1'], add: [5], remove: [] },
      { commentIds: ['c1'], add: [], remove: [5] },
    ]);
  });

  it('removes labels, and rolls back with an error toast on failure', async () => {
    await load();
    store.items = store.items.map((i) => ({ ...i, labels: [5, 7] }));
    store.counts = full(4, 0, { 5: 4, 7: 4 });
    fetchMock.mockImplementation(() => json({ error: 'boom', code: 'internal' }, 500));
    expect(await store.applyLabels([], [5], ['c1'])).toBe(false);
    expect(store.items[0]!.labels).toEqual([5, 7]);
    expect(store.counts.byLabel).toEqual({ 5: 4, 7: 4 });
    expect(toasts.items.at(-1)?.kind).toBe('error');
  });

  it('prunes deleted labels from items and counts', async () => {
    await load();
    store.items = store.items.map((i) => ({ ...i, labels: [5, 7] }));
    store.counts = full(4, 0, { 5: 4, 7: 4 });
    store.pruneLabels(new Set([7]));
    expect(store.items[0]!.labels).toEqual([7]);
    expect(store.counts.byLabel).toEqual({ 7: 4 });
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
