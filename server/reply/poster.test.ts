import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, PostError, type QuotaTracker, type Repo, type YtComment } from '../contracts.js';
import { openRepo } from '../db/repo.js';
import { createHandoffPoster, createReplyPoster } from './poster.js';
import { account, fakeGateway, fakeGoogleAuth } from './test-helpers.js';

const ME = 'UCme';
const T0 = new Date('2026-03-01T12:00:00.000Z');
let nowMs: number;
const clock = () => new Date(nowMs);

function yt(id: string, o: Partial<YtComment> = {}): YtComment {
  return {
    id,
    parentId: null,
    videoId: 'vid1',
    authorName: id,
    authorChannelId: `UCa_${id}`,
    authorAvatarUrl: null,
    textHtml: id,
    likeCount: 0,
    publishedAt: new Date(T0.getTime() - 3_600_000).toISOString(),
    updatedAt: new Date(T0.getTime() - 3_600_000).toISOString(),
    ...o,
  };
}

let repo: Repo;
let quota: QuotaTracker & { charges: [string, number][]; manual: boolean; blocked: boolean };
let auth: ReturnType<typeof fakeGoogleAuth>;

function mkQuota() {
  const q = {
    charges: [] as [string, number][],
    manual: true,
    blocked: false,
    dayPt: () => 'd',
    charge(e: string, n: number) {
      q.charges.push([e, n]);
    },
    used: () => 0,
    snapshot: () => ({ dayPt: 'd', used: 0, budget: 1, reserve: 0, blockedUntil: null }),
    canPoll: () => true,
    canManual: () => q.manual,
    blockUntilNextDay() {
      q.blocked = true;
    },
  };
  return q;
}

beforeEach(() => {
  nowMs = T0.getTime();
  repo = openRepo(':memory:', clock);
  repo.upsertVideos([
    {
      id: 'vid1',
      title: 'V',
      channelId: 'UCchan',
      channelTitle: 'C',
      thumbnailUrl: null,
      publishedAt: null,
      viewCount: 0,
      commentCount: 0,
    },
  ]);
  repo.upsertThread({
    id: 't1',
    videoId: 'vid1',
    channelId: 'UCchan',
    canReply: true,
    topComment: yt('t1'),
    totalReplyCount: 1,
    replies: [yt('t1.r1', { parentId: 't1' })],
  });
  quota = mkQuota();
  auth = fakeGoogleAuth([account(ME, { isDefault: true })]);
});

const mk = (gw: ReturnType<typeof fakeGateway>) =>
  createReplyPoster({ repo, auth, quota, gateway: gw, handoff: createHandoffPoster(repo), clock });

const insertedFor = (parentId: string, text: string): YtComment =>
  yt('new1', {
    parentId,
    authorChannelId: ME,
    textHtml: text,
    publishedAt: new Date(nowMs + 1000).toISOString(),
  });

describe('api posting', () => {
  it('posts to the thread id for a top-level target and charges 50', async () => {
    const gw = fakeGateway({ insertReply: async (_t, p) => insertedFor(p.parentId, p.text) });
    const res = await mk(gw).reply(repo.getComment('t1')!, '  hello  ');
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]!.args).toEqual([`tok-${ME}`, { parentId: 't1', videoId: 'vid1', text: 'hello' }]);
    expect(quota.charges).toEqual([['comments.insert', 50]]);
    expect(res.mode).toBe('posted');
  });

  it('uses the top-level id as parent when replying to a reply', async () => {
    const gw = fakeGateway({ insertReply: async (_t, p) => insertedFor(p.parentId, p.text) });
    await mk(gw).reply(repo.getComment('t1.r1')!, 'x');
    expect((gw.calls[0]!.args[1] as { parentId: string }).parentId).toBe('t1');
  });

  it('records the result: target replied (user), reply own, older cleared, draft posted, undo only target', async () => {
    const gw = fakeGateway({ insertReply: async (_t, p) => insertedFor(p.parentId, p.text) });
    const res = await mk(gw).reply(repo.getComment('t1')!, 'hello');
    if (res.mode !== 'posted') throw new Error('expected posted');
    expect(res.comment).toMatchObject({ id: 'new1', isOwn: true, state: 'own' });
    expect(repo.getComment('t1')).toMatchObject({ state: 'replied', stateSource: 'user' });
    expect(repo.getComment('t1.r1')!.state).toBe('auto_replied');
    expect(repo.getDraft('t1')).toMatchObject({ status: 'posted', body: 'hello' });
    repo.undo(res.actionId);
    expect(repo.getComment('t1')!.state).toBe('inbox');
    expect(repo.getComment('new1')).not.toBeNull();
  });

  it('registers the posting channel as own when it was not yet', async () => {
    expect(repo.getSettings().ownChannelIds).toEqual([]);
    const gw = fakeGateway({ insertReply: async (_t, p) => insertedFor(p.parentId, p.text) });
    await mk(gw).reply(repo.getComment('t1')!, 'hello');
    expect(repo.getSettings().ownChannelIds).toEqual([ME]);
  });

  it('picks the account matching the video owner, else the default', async () => {
    auth.accounts.push(account('UCchan'));
    const gw = fakeGateway({ insertReply: async (_t, p) => insertedFor(p.parentId, p.text) });
    await mk(gw).reply(repo.getComment('t1')!, 'a');
    expect(gw.calls[0]!.args[0]).toBe('tok-UCchan');
  });

  it('rejects a second reply while one is in flight (409) and frees the slot afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gw = fakeGateway({
      insertReply: async (_t, p) => {
        await gate;
        return insertedFor(p.parentId, p.text);
      },
    });
    const poster = mk(gw);
    const first = poster.reply(repo.getComment('t1')!, 'one');
    await vi.waitFor(() => expect(gw.calls).toHaveLength(1));
    await expect(poster.reply(repo.getComment('t1')!, 'two')).rejects.toMatchObject({
      code: 'duplicate_in_flight',
      status: 409,
    });
    release();
    await first;
    expect(gw.calls).toHaveLength(1);
  });

  it('same body within 10 minutes does not call YouTube again; after that it does', async () => {
    const gw = fakeGateway({
      insertReply: async (_t, p) => insertedFor(p.parentId, p.text),
    });
    const poster = mk(gw);
    await poster.reply(repo.getComment('t1')!, 'same');
    const again = await poster.reply(repo.getComment('t1')!, 'same');
    expect(again).toMatchObject({ mode: 'posted', comment: { id: 'new1' } });
    expect(gw.calls).toHaveLength(1);
    expect(quota.charges).toHaveLength(1);
    nowMs += 11 * 60_000;
    gw.insertReply = async (_t, p) => ({ ...insertedFor(p.parentId, p.text), id: 'new2' });
    await poster.reply(repo.getComment('t1')!, 'same');
    expect(quota.charges).toHaveLength(2);
  });

  it('validates text and replyability before spending quota', async () => {
    const gw = fakeGateway({});
    const poster = mk(gw);
    const c = repo.getComment('t1')!;
    await expect(poster.reply(c, '   ')).rejects.toMatchObject({ code: 'bad_text' });
    await expect(poster.reply(c, 'x'.repeat(10_001))).rejects.toMatchObject({ code: 'text_too_long' });
    repo.setThreadCanReply('t1', false);
    await expect(poster.reply(c, 'x')).rejects.toMatchObject({ code: 'cannot_reply', status: 422 });
    expect(gw.calls).toHaveLength(0);
    expect(quota.charges).toHaveLength(0);
  });

  it('429 when the manual quota is exhausted', async () => {
    quota.manual = false;
    await expect(mk(fakeGateway({})).reply(repo.getComment('t1')!, 'x')).rejects.toMatchObject({
      code: 'quota_exhausted',
      status: 429,
    });
  });
});

describe('error mapping', () => {
  const failWith = (status: number, reason: string | null, network = false) =>
    fakeGateway({
      insertReply: async () => {
        throw new GatewayError('boom', status, reason, network);
      },
    });
  const run = (gw: ReturnType<typeof fakeGateway>) => mk(gw).reply(repo.getComment('t1')!, 'hi');

  it.each([
    [401, null, 'auth_required', 401],
    [403, 'insufficientPermissions', 'auth_required', 401],
    [403, 'quotaExceeded', 'quota_exhausted', 429],
    [403, 'dailyLimitExceeded', 'quota_exhausted', 429],
    [429, null, 'rate_limited', 429],
    [403, 'rateLimitExceeded', 'rate_limited', 429],
    [403, 'userRateLimitExceeded', 'rate_limited', 429],
    [400, 'operationNotSupported', 'cannot_reply', 422],
    [403, 'forbidden', 'cannot_reply', 422],
    [403, 'commentsDisabled', 'cannot_reply', 422],
    [400, 'parentCommentIsPrivate', 'cannot_reply', 422],
    [404, 'parentCommentNotFound', 'comment_gone', 404],
    [400, 'commentTextTooLong', 'text_too_long', 400],
    [400, 'commentTextRequired', 'bad_text', 400],
    [400, 'invalidCustomEmoji', 'bad_text', 400],
    [400, 'processingFailure', 'bad_text', 400],
    [403, 'ineligibleAccount', 'ineligible_account', 403],
  ])('%i %s -> %s', async (status, reason, code, httpStatus) => {
    const gw = failWith(status, reason);
    await expect(run(gw)).rejects.toMatchObject({ name: 'PostError', code, status: httpStatus });
    expect(gw.calls).toHaveLength(1); // never retried, never verified
    expect(repo.getComment('t1')!.state).toBe('inbox');
  });

  it('auth_required flags the account for reauth and flips capabilities to hand-off', async () => {
    const poster = mk(failWith(401, null));
    // fake auth reads the row object we mutate through the repo, so mirror it: real auth reads the repo
    repo.upsertGoogleAccount(auth.accounts[0]!);
    await expect(poster.reply(repo.getComment('t1')!, 'hi')).rejects.toMatchObject({ code: 'auth_required' });
    expect(repo.listGoogleAccounts()[0]).toMatchObject({ needsReauth: true });
    auth.accounts[0]!.needsReauth = true;
    expect(poster.capabilities()).toEqual({ canPost: false, postMode: 'handoff' });
  });

  it('quotaExceeded blocks the quota tracker until the next day', async () => {
    await expect(run(failWith(403, 'quotaExceeded'))).rejects.toBeInstanceOf(PostError);
    expect(quota.blocked).toBe(true);
  });

  it('operationNotSupported sets can_reply = 0', async () => {
    await expect(run(failWith(400, 'operationNotSupported'))).rejects.toBeInstanceOf(PostError);
    expect(repo.getThread('t1')!.canReply).toBe(false);
  });

  it('retries once only when the request provably never left (ECONNREFUSED), charging once', async () => {
    let n = 0;
    const gw = fakeGateway({
      insertReply: async (_t, p) => {
        if (n++ === 0) throw new GatewayError('refused', 0, 'ECONNREFUSED', true);
        return insertedFor(p.parentId, p.text);
      },
    });
    await expect(run(gw)).resolves.toMatchObject({ mode: 'posted' });
    expect(gw.calls.map((c) => c.fn)).toEqual(['insertReply', 'insertReply']);
    expect(quota.charges).toEqual([['comments.insert', 50]]);
  });

  it('gives up with post_failed after a second never-sent failure, without verifying', async () => {
    const gw = failWith(0, 'ENOTFOUND', true);
    await expect(run(gw)).rejects.toMatchObject({ code: 'post_failed' });
    expect(gw.calls.map((c) => c.fn)).toEqual(['insertReply', 'insertReply']);
  });
});

describe('ambiguous failures are verified, never re-inserted', () => {
  const sentLooksLike = (list: () => Promise<YtComment[]>, status = 0, reason: string | null = 'timeout') =>
    fakeGateway({
      insertReply: async () => {
        throw new GatewayError('timeout', status, reason, status === 0);
      },
      listReplies: list,
    });
  const run = (gw: ReturnType<typeof fakeGateway>) => mk(gw).reply(repo.getComment('t1')!, 'hello world');

  it('timeout then found (HTML-formatted, within the time window) is treated as success', async () => {
    const gw = sentLooksLike(async () => [
      yt('other', { authorChannelId: 'UCsomeoneelse', textHtml: 'hello world' }),
      yt('landed', {
        parentId: 't1',
        authorChannelId: ME,
        textHtml: 'hello   <b>world</b>',
        publishedAt: new Date(nowMs + 2000).toISOString(),
      }),
    ]);
    const res = await run(gw);
    expect(res).toMatchObject({ mode: 'posted', comment: { id: 'landed' } });
    expect(gw.calls.map((c) => c.fn)).toEqual(['insertReply', 'listReplies']);
    expect(quota.charges).toEqual([
      ['comments.insert', 50],
      ['comments.list', 1],
    ]);
  });

  it('5xx then not found -> post_failed (retryable), insert called once', async () => {
    const gw = sentLooksLike(async () => [], 503, 'backendError');
    await expect(run(gw)).rejects.toMatchObject({ code: 'post_failed', status: 502, retryable: true });
    expect(gw.calls.filter((c) => c.fn === 'insertReply')).toHaveLength(1);
    expect(repo.getComment('t1')!.state).toBe('inbox');
  });

  it('ignores a same-text comment that predates the attempt', async () => {
    const gw = sentLooksLike(async () => [
      yt('old', { authorChannelId: ME, textHtml: 'hello world', publishedAt: new Date(nowMs - 60_000).toISOString() }),
    ]);
    await expect(run(gw)).rejects.toMatchObject({ code: 'post_failed' });
  });

  it('verification failure -> post_unconfirmed, recorded as unknown', async () => {
    const gw = sentLooksLike(async () => {
      throw new GatewayError('down', 0, 'timeout', true);
    });
    await expect(run(gw)).rejects.toMatchObject({ code: 'post_unconfirmed', status: 502 });
    expect(gw.calls.filter((c) => c.fn === 'insertReply')).toHaveLength(1);
    // a later identical send is not blocked by the dedupe (nothing was confirmed posted)
    expect(repo.recentPostedReply('t1', 'x', '1970-01-01T00:00:00.000Z')).toBeNull();
  });
});

describe('switching', () => {
  it('reports api capabilities with postAs, and hand-off when no usable account', () => {
    const poster = mk(fakeGateway({}));
    expect(poster.capabilities()).toEqual({
      canPost: true,
      postMode: 'api',
      postAs: { channelId: ME, title: `Channel ${ME}` },
    });
    auth.accounts[0]!.needsReauth = true;
    expect(poster.capabilities()).toEqual({ canPost: false, postMode: 'handoff' });
  });

  it('hands off when not api-capable', async () => {
    auth.accounts.length = 0;
    const gw = fakeGateway({});
    const res = await mk(gw).reply(repo.getComment('t1')!, 'hi');
    expect(res.mode).toBe('handoff');
    expect(gw.calls).toHaveLength(0);
    expect(repo.getComment('t1')!.state).toBe('replied');
  });

  it('api-capable but the token cannot be obtained -> auth_required, no silent hand-off', async () => {
    auth.getAccessToken = async () => {
      throw new PostError('auth_required', 'expired', 401);
    };
    const gw = fakeGateway({});
    await expect(mk(gw).reply(repo.getComment('t1')!, 'hi')).rejects.toMatchObject({ code: 'auth_required' });
    expect(repo.getComment('t1')!.state).toBe('inbox');
    expect(repo.getDraft('t1')).toBeNull();
  });
});

describe('deleteReply', () => {
  async function postOne() {
    const gw = fakeGateway({
      insertReply: async (_t, p) => insertedFor(p.parentId, p.text),
      deleteComment: async () => {},
    });
    const poster = mk(gw);
    await poster.reply(repo.getComment('t1')!, 'hello');
    quota.charges.length = 0;
    return { gw, poster };
  }

  it('deletes at YouTube, charges 50 and removes the local row', async () => {
    const { gw, poster } = await postOne();
    await poster.deleteReply!(repo.getComment('new1')!);
    expect(gw.calls.at(-1)).toMatchObject({ fn: 'deleteComment', args: [`tok-${ME}`, 'new1'] });
    expect(quota.charges).toEqual([['comments.delete', 50]]);
    expect(repo.getComment('new1')).toBeNull();
  });

  it('refuses comments that are not our own app-posted replies', async () => {
    const { gw, poster } = await postOne();
    repo.addReplies('t1', [yt('manual', { parentId: 't1', authorChannelId: ME })]);
    await expect(poster.deleteReply!(repo.getComment('manual')!)).rejects.toMatchObject({ code: 'cannot_reply' });
    await expect(poster.deleteReply!(repo.getComment('t1.r1')!)).rejects.toMatchObject({ code: 'cannot_reply' });
    expect(gw.calls.filter((c) => c.fn === 'deleteComment')).toHaveLength(0);
  });

  it('treats 404 as already deleted but surfaces other failures and keeps the row', async () => {
    const { gw, poster } = await postOne();
    gw.deleteComment = async () => {
      throw new GatewayError('x', 404, 'commentNotFound');
    };
    await poster.deleteReply!(repo.getComment('new1')!);
    expect(repo.getComment('new1')).toBeNull();

    const again = await postOneAgain();
    again.gw.deleteComment = async () => {
      throw new GatewayError('x', 500, 'backendError');
    };
    await expect(again.poster.deleteReply!(repo.getComment('new2')!)).rejects.toMatchObject({ code: 'post_failed' });
    expect(repo.getComment('new2')).not.toBeNull();
  });

  async function postOneAgain() {
    const gw = fakeGateway({ insertReply: async (_t, p) => ({ ...insertedFor(p.parentId, p.text), id: 'new2' }) });
    const poster = mk(gw);
    nowMs += 11 * 60_000;
    await poster.reply(repo.getComment('t1')!, 'again');
    return { gw, poster };
  }
});
