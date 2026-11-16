import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { AssistantAction, LlmClient, SyncEngine } from '../contracts.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import { makeEnv } from '../sync/test-helpers.js';
import type { NoteDTO } from '../../shared/types.js';

const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let actions: AssistantAction[];
let seenInput: Parameters<LlmClient['command']>[0] | null;
let kicks: string[];

const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, payload: payload as never });
const id = (n: number) => `gh:o/r#${n}`;

beforeEach(() => {
  env = makeEnv({});
  actions = [];
  seenInput = null;
  kicks = [];
  const feed = env.repo.addFeed({ owner: 'o', prs: true, issues: true, importMode: 'none' });
  env.repo.upsertGithubItems(
    feed.id,
    [1, 2].map((n) => ({
      id: id(n),
      kind: 'issue' as const,
      repo: 'o/r',
      number: n,
      title: `Issue ${n}`,
      author: 'bob',
      authorAvatarUrl: null,
      authorType: 'User',
      association: 'NONE' as const,
      bodyPlain: '',
      url: 'u',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceState: 'open' as const,
      draft: false,
      comments: 0,
      labels: [],
    })),
  );
  env.repo.updateSettings({ llm: { apiKey: 'sk-test', model: 'm' } });
  app = buildApp({
    repo: env.repo,
    engine: { run: async () => ({}), status: () => ({}) } as unknown as SyncEngine,
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
    llm: {
      test: async () => ({ ok: true, message: '' }),
      command: async (input) => {
        seenInput = input;
        return { actions, reply: '' };
      },
    },
    suggest: {
      notify: (ids) => kicks.push(`notify ${ids.join(',')}`),
      kick: () => kicks.push('kick'),
    },
  });
});
afterEach(() => app.close());

const say = (text: string, over: object = {}) => send('POST', '/api/assistant', { text, ...over });
const note = (text: string, scope: 'item' | 'standing', about: 'selected' | 'last_action' = 'selected') =>
  ({ type: 'note', text, scope, about }) as const;
const item = (n: number) => env.repo.listInbox({ view: 'all' }).items.find((i) => i.item.id === id(n))!;

describe('POST /api/snooze with a why', () => {
  it('stores one line of why on every item, tidied and clipped, and skipping it costs nothing', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await send('POST', '/api/snooze', {
      commentIds: [id(1), id(2)],
      until,
      why: `  review\nthe fix ${'x'.repeat(300)}`,
    });
    expect(item(1).snoozeWhy).toMatch(/^review the fix x+$/);
    expect(item(1).snoozeWhy!.length).toBe(200);
    expect(item(2).snoozeWhy).toBe(item(1).snoozeWhy);
    const again = new Date(Date.now() + 7_200_000).toISOString();
    await send('POST', '/api/snooze', { commentIds: [id(1)], until: again });
    expect(item(1).snoozeWhy).toBeNull();
  });
});

describe('the assistant records notes', () => {
  it('stores a standing preference verbatim, with the item that was selected as context', async () => {
    actions = [note("It's from my friend Bob, those are always important", 'standing')];
    const res = await say("it's from my friend Bob, those are always important", { selectedId: id(1), via: 'voice' });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcomes).toEqual([expect.objectContaining({ type: 'note', scope: 'standing', itemId: id(1) })]);
    const [n] = env.repo.notes.list();
    expect(n).toMatchObject({
      text: "It's from my friend Bob, those are always important",
      scope: 'standing',
      source: 'voice',
      itemId: id(1),
      itemTitle: 'Issue 1',
      enabled: true,
    });
    expect(env.bus.of('notes.changed')).toHaveLength(1);
    expect(kicks).toEqual(['kick']);
  });

  it('attaches "that" to the item he just snoozed when the selection has moved on, and records the why he gave', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    env.repo.snooze([id(1)], until, 'review the proposed fix');
    actions = [note("I wouldn't have snoozed that", 'item', 'last_action')];
    await say("I wouldn't have snoozed that", { selectedId: id(2) });
    expect(seenInput!.recent).toMatchObject({ what: 'snoozed', title: 'Issue 1' });
    const [n] = env.repo.notes.list();
    expect(n).toMatchObject({ scope: 'item', itemId: id(1), source: 'text' });
    expect(n!.lastAction).toMatchObject({ kind: 'snooze', why: 'review the proposed fix' });
    expect(kicks).toEqual([`notify ${id(1)}`]);
  });

  it('falls back to the most recent action when nothing is selected, and to no item when there was none', async () => {
    actions = [note('that suggestion was wrong', 'item')];
    await say('that suggestion was wrong');
    expect(env.repo.notes.list()[0]!.itemId).toBeNull();
    env.repo.triage([id(2)], 'done');
    await say('that suggestion was wrong');
    expect(env.repo.notes.list()[0]).toMatchObject({ itemId: id(2), lastAction: { kind: 'state', to: 'done' } });
  });

  it('snoozes with the why the assistant understood, and can do both in one command', async () => {
    actions = [
      {
        type: 'snooze',
        until: new Date(Date.now() + 86_400_000).toISOString(),
        why: 'review the proposed fix',
        bucket: null,
        untilActivity: false,
      },
      note('waiting on a fix', 'item'),
    ];
    const res = await say('snooze this until tomorrow to review the proposed fix, I am waiting on a fix', {
      selectedId: id(1),
    });
    expect(res.json().outcomes.map((o: { type: string }) => o.type)).toEqual(['snooze', 'note']);
    expect(item(1).snoozeWhy).toBe('review the proposed fix');
    expect(env.repo.notes.list()[0]).toMatchObject({ itemId: id(1), lastAction: { why: 'review the proposed fix' } });
  });

  it('records no note when the assistant is off: the words become a todo as before', async () => {
    env.repo.updateSettings({ llm: { apiKey: null, model: 'm' } });
    const res = await say('Bob is always important');
    expect(res.json().fallback).toBe('off');
    expect(env.repo.notes.list()).toEqual([]);
  });
});

describe('notes API', () => {
  const seed = (text = 'one', scope: 'item' | 'standing' = 'standing', itemId: string | null = null): NoteDTO =>
    env.repo.notes.add({ text, scope, source: 'text', itemId });

  it('lists newest first', async () => {
    seed('a');
    seed('b');
    const res = await send('GET', '/api/notes');
    expect((res.json() as NoteDTO[]).map((n) => n.text)).toEqual(['b', 'a']);
  });

  it('edits text, switches a note off and on, and tells the suggestion worker and every tab', async () => {
    const n = seed('Bob matters');
    const res = await send('PATCH', `/api/notes/${n.id}`, { text: 'Bob always matters', enabled: false });
    expect(res.json()).toMatchObject({ text: 'Bob always matters', enabled: false, originalText: 'Bob matters' });
    expect(env.repo.notes.standing().texts).toEqual([]);
    expect(env.bus.of('notes.changed').at(-1)!.notes[0]).toMatchObject({ enabled: false });
    expect(kicks).toEqual(['kick']);
  });

  it('re-asks the item when an item note changes', async () => {
    const n = seed('waiting', 'item', id(1));
    await send('PATCH', `/api/notes/${n.id}`, { enabled: false });
    expect(kicks).toEqual([`notify ${id(1)}`]);
  });

  it('rejects empty or overlong text, bad scopes, empty patches and unknown notes', async () => {
    const n = seed();
    expect((await send('PATCH', `/api/notes/${n.id}`, { text: '   ' })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/notes/${n.id}`, { text: 'x'.repeat(1001) })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/notes/${n.id}`, { scope: 'global' })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/notes/${n.id}`, {})).statusCode).toBe(400);
    expect((await send('PATCH', '/api/notes/999', { text: 'x' })).statusCode).toBe(404);
    expect((await send('DELETE', '/api/notes/999')).statusCode).toBe(404);
  });

  it('deletes a note and announces it', async () => {
    const n = seed();
    expect((await send('DELETE', `/api/notes/${n.id}`)).statusCode).toBe(204);
    expect(env.repo.notes.list()).toEqual([]);
    expect(env.bus.of('notes.changed').at(-1)!.notes).toEqual([]);
  });

  it('refuses changes without the CSRF header, like every other write', async () => {
    const n = seed();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${n.id}`,
      headers: { host: '127.0.0.1:4517' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(env.repo.notes.list()).toHaveLength(1);
  });
});
