import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { SyncEngine } from '../contracts.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeEnv } from '../sync/test-helpers.js';
import type { ServerEvent } from '../../shared/types.js';

// Real repo behind the real routes: snooze + label endpoints, validation and events.
const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };

let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let events: ServerEvent[];

const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, payload: payload as never });
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
  const engine = { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine;
  app = buildApp({
    repo: env.repo,
    engine,
    bus: env.bus,
    quota: env.quota,
    poster: createHandoffPoster(env.repo),
    auth: fakeGoogleAuth(),
    addSource: async () => {
      throw new Error('unused');
    },
    testKey: async () => ({ ok: true, message: '' }),
    onSettingsChanged: () => {},
    resolveApiKey: () => ({ key: 'k', source: 'env' }),
    demo: false,
  });
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

describe('labels routes', () => {
  it('creates, lists, patches and deletes, emitting labels.changed', async () => {
    const c = await send('POST', '/api/labels', { name: ' Question ' });
    expect(c.statusCode).toBe(201);
    const label = c.json();
    expect(label).toMatchObject({ name: 'Question', color: 'red' });
    expect(events.at(-1)).toMatchObject({ type: 'labels.changed', labels: [label] });
    expect((await get('/api/labels')).json()).toEqual([label]);

    const p = await send('PATCH', `/api/labels/${label.id}`, { name: 'Q', color: 'blue' });
    expect(p.json()).toMatchObject({ id: label.id, name: 'Q', color: 'blue' });
    expect(events.at(-1)).toMatchObject({ type: 'labels.changed' });

    const d = await send('DELETE', `/api/labels/${label.id}`);
    expect(d.statusCode).toBe(204);
    expect((await get('/api/labels')).json()).toEqual([]);
  });

  it('maps errors: duplicate 409, too long / empty 400, unknown 404, bad colour 400', async () => {
    await send('POST', '/api/labels', { name: 'Bug' });
    const dup = await send('POST', '/api/labels', { name: 'bug' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('duplicate_label');
    for (const name of ['', '   ', 'x'.repeat(41)]) {
      const r = await send('POST', '/api/labels', { name });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('bad_name');
    }
    expect((await send('POST', '/api/labels', { name: 'ok', color: 'chartreuse' })).statusCode).toBe(400);
    expect((await send('PATCH', '/api/labels/999', { name: 'z' })).statusCode).toBe(404);
    expect((await send('DELETE', '/api/labels/999')).statusCode).toBe(404);
    expect((await send('DELETE', '/api/labels/abc')).statusCode).toBe(400);
  });

  it('answers 409 too_many_labels at the cap', async () => {
    for (let i = 0; i < 100; i++) env.repo.createLabel(`L${i}`);
    const r = await send('POST', '/api/labels', { name: 'extra' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('too_many_labels');
  });

  it('applies labels, filters the inbox by labelId and emits inbox.changed', async () => {
    const l = (await send('POST', '/api/labels', { name: 'A' })).json();
    const res = await send('POST', '/api/labels/apply', { commentIds: ['c1', 'nope'], add: [l.id, 777] });
    expect(res.statusCode).toBe(200);
    expect(res.json().labels).toEqual({ c1: [l.id] });
    expect(res.json().counts.byLabel).toEqual({ [l.id]: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'inbox.changed', changedIds: ['c1'] });
    const list = (await get(`/api/inbox?view=inbox&labelId=${l.id}`)).json();
    expect(list.items.map((i: { comment: { id: string } }) => i.comment.id)).toEqual(['c1']);
    expect(list.items[0].labels).toEqual([l.id]);
    expect((await get('/api/inbox?labelId=abc')).statusCode).toBe(400);

    const again = await send('POST', '/api/labels/apply', { commentIds: ['c1'], add: [l.id] });
    expect(again.json().labels).toEqual({});
    const rm = await send('POST', '/api/labels/apply', { commentIds: ['c1'], remove: [l.id] });
    expect(rm.json().labels).toEqual({ c1: [] });
    expect((await send('POST', '/api/labels/apply', { commentIds: [], add: [1] })).statusCode).toBe(400);
    expect((await send('POST', '/api/labels/apply', { commentIds: ['c1'], add: 'x' })).statusCode).toBe(400);
  });

  it('delete emits inbox.changed for the comments that carried the label', async () => {
    const l = (await send('POST', '/api/labels', { name: 'A' })).json();
    await send('POST', '/api/labels/apply', { commentIds: ['c2'], add: [l.id] });
    await send('DELETE', `/api/labels/${l.id}`);
    const types = events.slice(-2).map((e) => e.type);
    expect(types).toEqual(['labels.changed', 'inbox.changed']);
    expect(events.at(-1)).toMatchObject({ changedIds: ['c2'] });
  });

  it('bootstrap includes labels and the new counts', async () => {
    const l = (await send('POST', '/api/labels', { name: 'A' })).json();
    const b = (await get('/api/bootstrap')).json();
    expect(b.labels).toEqual([l]);
    expect(b.counts).toMatchObject({ snoozed: 0, byLabel: { [l.id]: 0 } });
  });
});
