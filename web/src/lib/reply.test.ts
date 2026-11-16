import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Counts, InboxItem } from '../../../shared/types';
import { handoff, send } from './reply';
import { drafts } from './stores/drafts.svelte';
import { inbox } from './stores/inbox.svelte';
import { settings } from './stores/settings.svelte';
import { toasts } from './stores/toasts.svelte';

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

function item(n: number): InboxItem {
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
      textHtml: 'hi',
      textPlain: 'hi',
      likeCount: 0,
      publishedAt: new Date(Date.UTC(2025, 0, 1, 0, 100 - n)).toISOString(),
      updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 100 - n)).toISOString(),
      isOwn: false,
      state: 'inbox',
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

describe('reply (api mode)', () => {
  let replyResponse: () => Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let restore: ReturnType<typeof vi.spyOn>;
  let discard: ReturnType<typeof vi.spyOn>;

  const calls = (suffix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
  const last = () => toasts.items.at(-1)!;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    toasts.items = [];
    inbox.items = [item(1), item(2)];
    inbox.selectedId = 'c1';
    inbox.counts = counts(2, 0);
    settings.capabilities = { canPost: true, postMode: 'api', postAs: { channelId: 'UC1', title: 'My Channel' } };
    replyResponse = () =>
      json({
        mode: 'posted',
        actionId: 3,
        comment: { ...item(9).comment, permalink: 'https://www.youtube.com/watch?v=v1&lc=NEW' },
      });
    fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/reply')) return replyResponse();
      if (url === '/api/triage') return json({ actionId: 4, changes: [], counts: counts(1, 0) });
      return json({ error: 'nope', code: 'x' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    open = vi.fn(() => ({ opener: null }));
    vi.stubGlobal('open', open);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    restore = vi.spyOn(drafts, 'restore');
    discard = vi.spyOn(drafts, 'discard');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a sticky posting toast, then a success toast with an Open action', async () => {
    let release!: () => void;
    replyResponse = () =>
      new Promise((res) => {
        release = () =>
          res(
            new Response(
              JSON.stringify({ mode: 'posted', actionId: 3, comment: { ...item(9).comment, permalink: 'P' } }),
              { status: 200 },
            ),
          );
      });
    send(inbox.items[0]!, 'hello');
    expect(last().message).toBe('Posting reply…');
    expect(last().timeoutMs).toBe(0);
    release();
    await flush();
    expect(toasts.items.some((t) => t.message === 'Posting reply…')).toBe(false);
    expect(last().message).toBe('Reply posted as My Channel · z moves it back to inbox');
    last().action!.run();
    expect(open).toHaveBeenCalledWith('P', '_blank', 'noopener');
    expect(discard).toHaveBeenCalledWith('c1');
  });

  it('ignores a second send for the same comment while one is in flight', async () => {
    const it1 = inbox.items[0]!;
    send(it1, 'hello');
    send(it1, 'hello');
    await flush();
    expect(calls('/reply')).toHaveLength(1);
  });

  it.each([
    ['auth_required', 401, ['Reconnect', 'Copy & open']],
    ['quota_exhausted', 429, ['Copy & open']],
    ['cannot_reply', 422, ['Copy & open']],
    ['rate_limited', 429, ['Retry']],
    ['post_failed', 502, ['Retry']],
    ['comment_gone', 404, ['Done']],
    ['ineligible_account', 403, ['Settings']],
  ])('%s maps to toast actions', async (code, status, labels) => {
    replyResponse = () => json({ error: 'nope', code }, status);
    send(inbox.items[0]!, 'hello');
    await flush();
    const errs = toasts.items.filter((t) => t.action);
    expect(errs.map((t) => t.action!.label)).toEqual(labels);
    // The generic rollback toast is replaced by ours and the draft is back for editing.
    expect(toasts.items.some((t) => t.message.startsWith('Could not update'))).toBe(false);
    expect(restore).toHaveBeenCalledWith('c1', 'hello');
    expect(inbox.items.find((i) => i.comment.id === 'c1')?.comment.state).toBe('inbox');
  });

  it.each(['text_too_long', 'bad_text'])('%s restores the draft with no action', async (code) => {
    replyResponse = () => json({ error: 'too long', code }, 400);
    send(inbox.items[0]!, 'hello');
    await flush();
    expect(restore).toHaveBeenCalledWith('c1', 'hello');
    expect(last().kind).toBe('error');
    expect(last().action).toBeUndefined();
  });

  it('Retry re-sends', async () => {
    replyResponse = () => json({ error: 'x', code: 'rate_limited' }, 429);
    send(inbox.items[0]!, 'hello');
    await flush();
    last().action!.run();
    await flush();
    expect(calls('/reply')).toHaveLength(2);
  });

  it('post_unconfirmed does not treat the draft as unsent', async () => {
    replyResponse = () => json({ error: 'unsure', code: 'post_unconfirmed' }, 502);
    send(inbox.items[0]!, 'hello');
    await flush();
    expect(restore).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith('c1');
    expect(last().action?.label).toBe('Open on YouTube');
  });

  it('does not claim a post when the server only recorded a hand-off (stale api mode)', async () => {
    replyResponse = () => json({ mode: 'handoff', url: 'https://www.youtube.com/watch?v=v1&lc=c1', actionId: 9 }, 200);
    send(inbox.items[0]!, 'hello');
    await flush();
    expect(toasts.items.some((t) => t.message.startsWith('Reply posted'))).toBe(false);
    expect(last().kind).toBe('error');
    expect(last().message).toContain('Not posted');
    expect(last().action?.label).toBe('Copy & open');
  });

  it('handoff in api mode copies, opens and marks replied without posting', async () => {
    handoff(inbox.items[0]!, 'hello');
    expect(open).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
    await flush();
    expect(calls('/reply')).toHaveLength(0);
    expect(calls('/api/triage')).toHaveLength(1);
  });

  it("the hand-off toast's Undo undoes that hand-off, not a later action", async () => {
    let next = 40;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/triage') return json({ actionId: next++, changes: [], counts: counts(1, 1) });
      if (/\/api\/triage\/\d+\/undo$/.test(url)) return json({ actionId: 1, changes: [], counts: counts(1, 1) });
      return json({ error: 'nope', code: 'x' }, 404);
    });
    handoff(inbox.items[0]!, 'hello'); // action 40
    await flush();
    const toast = toasts.items.find((t) => t.message.includes('marked replied'))!;
    await inbox.triage('done', ['c2']); // action 41
    toast.action!.run();
    await vi.waitFor(() => expect(calls('/api/triage/40/undo')).toHaveLength(1));
    expect(calls('/api/triage/41/undo')).toHaveLength(0);
  });

  it('hand-off mode goes through the server reply route', async () => {
    settings.capabilities = { canPost: true, postMode: 'handoff' };
    replyResponse = () => json({ mode: 'handoff', url: 'u', actionId: 5 });
    send(inbox.items[0]!, 'hello');
    await flush();
    expect(calls('/reply')).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
