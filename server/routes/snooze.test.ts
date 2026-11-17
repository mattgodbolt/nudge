import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { makeEnv } from '../sync/test-helpers.js';
import type { ServerEvent } from '../../shared/types.js';
import { H, sender, testDeps } from './test-helpers.js';

// Real repo behind the real routes: snooze endpoints, validation and events.

let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let events: ServerEvent[];

const send = sender(() => app);
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: H.host } });
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

beforeEach(() => {
  env = makeEnv({});
  const s = env.repo.addSource({
    kind: 'playlist',
    ytId: 'PLx',
    title: 'P',
    thumbnailUrl: null,
    isOwn: false,
    importMode: 'all',
  });
  env.repo.setSourceVideos(s.id, [{ id: 'v1', position: 0 }]);
  for (const id of ['c1', 'c2']) {
    const published = new Date(Date.now() - HOUR).toISOString();
    env.repo.upsertThread({
      id,
      videoId: 'v1',
      channelId: 'UCchan',
      canReply: true,
      totalReplyCount: 0,
      replies: [],
      topComment: {
        id,
        parentId: null,
        videoId: 'v1',
        authorName: 'A',
        authorChannelId: 'UCx',
        authorAvatarUrl: null,
        textHtml: id,
        likeCount: 0,
        publishedAt: published,
        updatedAt: published,
      },
    });
  }
  events = [];
  env.bus.subscribe((e) => events.push(e));
  app = buildApp(testDeps(env.repo, { bus: env.bus, quota: env.quota }));
});
afterEach(() => app.close());

describe('POST /api/snooze', () => {
  it('snoozes, emits inbox.changed and the views follow', async () => {
    const until = inMs(2 * HOUR);
    const res = await send('POST', '/api/snooze', { commentIds: ['c1'], until });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actionId).toEqual(expect.any(Number));
    expect(body.changes).toEqual([{ commentId: 'c1', from: null, to: until }]);
    expect(body.counts).toMatchObject({ inbox: 1, snoozed: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'inbox.changed', addedIds: [], changedIds: ['c1'] });
    const snoozed = (await get('/api/inbox?view=snoozed')).json();
    expect(snoozed.items.map((i: { comment: { id: string } }) => i.comment.id)).toEqual(['c1']);
    expect(snoozed.items[0].snoozedUntil).toBe(until);
  });

  it('unsnoozes with until: null', async () => {
    await send('POST', '/api/snooze', { commentIds: ['c1'], until: inMs(HOUR) });
    const res = await send('POST', '/api/snooze', { commentIds: ['c1'], until: null });
    expect(res.json().changes).toHaveLength(1);
    expect(res.json().counts).toMatchObject({ inbox: 2, snoozed: 0 });
  });

  it.each([
    ['past', () => inMs(-HOUR)],
    ['too soon', () => inMs(5_000)],
    ['too far', () => inMs(400 * 24 * HOUR)],
    ['not a date', () => 'tomorrow-ish'],
    ['a number', () => 12345],
    ['missing', () => undefined],
  ])('rejects until that is %s with bad_until', async (_n, mk) => {
    const res = await send('POST', '/api/snooze', { commentIds: ['c1'], until: mk() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_until');
  });

  it.each([[[]], ['c1'], [[1]], [Array.from({ length: 501 }, (_, i) => `c${i}`)]])(
    'rejects bad commentIds %#',
    async (commentIds) => {
      const res = await send('POST', '/api/snooze', { commentIds, until: null });
      expect(res.statusCode).toBe(400);
    },
  );

  it('undoes via /api/snooze/:id/undo and 409s when it cannot', async () => {
    const s = (await send('POST', '/api/snooze', { commentIds: ['c1'], until: inMs(HOUR) })).json();
    const u = await send('POST', `/api/snooze/${s.actionId}/undo`);
    expect(u.statusCode).toBe(200);
    expect(u.json().changes).toEqual([{ commentId: 'c1', from: s.changes[0].to, to: null }]);
    expect(events.at(-1)).toMatchObject({ type: 'inbox.changed', changedIds: ['c1'] });
    const again = await send('POST', `/api/snooze/${s.actionId}/undo`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('cannot_undo');
    expect((await send('POST', '/api/snooze/9999/undo')).statusCode).toBe(409);
    // a triage action id is not a snooze action
    const t = (await send('POST', '/api/triage', { commentIds: ['c2'], to: 'done' })).json();
    expect((await send('POST', `/api/snooze/${t.actionId}/undo`)).statusCode).toBe(409);
  });
});

describe('bootstrap', () => {
  it('reports the snoozed count', async () => {
    await send('POST', '/api/snooze', { commentIds: ['c1'], until: inMs(HOUR) });
    const b = (await get('/api/bootstrap')).json();
    expect(b.counts).toMatchObject({ snoozed: 1, inbox: 1 });
    expect(b).not.toHaveProperty('labels');
  });
});

describe('retired label endpoints', () => {
  it('are gone', async () => {
    expect((await get('/api/labels')).statusCode).toBe(404);
    expect((await send('POST', '/api/labels/apply', { commentIds: ['c1'], add: [1] })).statusCode).toBe(404);
  });
});
