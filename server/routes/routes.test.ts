import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { AppDeps, Repo, StoredSettings } from '../contracts.js';
import { createEventBus } from '../events/bus.js';
import { createHandoffPoster } from '../reply/poster.js';
import { fakeGoogleAuth } from '../reply/test-helpers.js';
import type {
  CommentDTO,
  CommentState,
  Counts,
  ServerEvent,
  SourceDTO,
  SyncStatus,
  TriageResult,
} from '../../shared/types.js';

const H = { 'x-nudge': '1', host: '127.0.0.1:4517' };
const OWN = 'UC' + 'a'.repeat(22);

function comment(id: string, state: CommentState = 'inbox'): CommentDTO {
  return {
    id,
    threadId: 't1',
    parentId: null,
    videoId: 'vid',
    authorName: 'A',
    authorChannelId: 'UCx',
    authorAvatarUrl: null,
    textHtml: id,
    textPlain: id,
    likeCount: 0,
    publishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isOwn: false,
    state,
    stateSource: 'sync',
    permalink: `https://www.youtube.com/watch?v=vid&lc=${id}`,
  };
}

/** Minimal in-memory Repo: only what the routes touch. */
function stubRepo() {
  const comments = new Map([
    ['c1', comment('c1')],
    ['c2', comment('c2')],
  ]);
  const drafts = new Map<string, { body: string; updatedAt: string; status: 'draft' | 'handed_off' | 'posted' }>();
  const actions: { id: number; changes: { commentId: string; from: CommentState; to: CommentState }[] }[] = [];
  let settings: StoredSettings = {
    apiKey: null,
    googleClient: null,
    ownChannelIds: [],
    pollEnabled: true,
    dailyQuotaBudget: 9000,
    manualReserve: 1000,
    backfillDays: 14,
    theme: 'system',
    github: { token: null, myAccounts: [] },
    llm: { apiKey: null, model: 'claude-haiku-5-5' },
  };
  const sources: SourceDTO[] = [];
  const counts = (): Counts => {
    const all = [...comments.values()];
    return {
      inbox: all.filter((c) => c.state === 'inbox').length,
      done: all.filter((c) => ['done', 'replied', 'auto_replied'].includes(c.state)).length,
      all: all.length,
      snoozed: 0,
      bySource: {},
      byLabel: {},
      byFeed: {},
      byRepo: {},
      todos: 0,
    };
  };
  const move = (ids: string[], to: CommentState): TriageResult => {
    const changes = ids
      .filter((i) => comments.has(i))
      .map((commentId) => {
        const c = comments.get(commentId)!;
        const from = c.state;
        c.state = to;
        return { commentId, from, to };
      });
    actions.push({ id: actions.length + 1, changes });
    return { actionId: actions.length, changes, counts: counts() };
  };
  const repo = {
    close() {},
    getSettings: () => settings,
    updateSettings: (p: Partial<StoredSettings>) => (settings = { ...settings, ...p }),
    listSources: () => sources,
    listFeeds: () => [],
    listMuteRules: () => [],
    getSourceRow: (id: number) => (sources.find((s) => s.id === id) ? ({ id } as never) : null),
    updateSource: (id: number, p: Partial<SourceDTO>) =>
      Object.assign(
        sources.find((s) => s.id === id)!,
        p,
      ),
    deleteSource: (id: number) =>
      void sources.splice(
        sources.findIndex((s) => s.id === id),
        1,
      ),
    listVideos: () => [{ id: 'vid' }],
    getVideoSyncRow: (id: string) => (id === 'vid' ? ({ id } as never) : null),
    setVideoTier: (id: string, t: unknown) => ({ id, tierOverride: t }),
    recomputeOwnership: vi.fn(),
    listInbox: (q: { view: string }) => ({ items: [], nextCursor: null, total: q.view === 'inbox' ? 2 : 0 }),
    getThread: (id: string) => (id === 't1' ? { threadId: 't1', comments: [...comments.values()] } : null),
    getComment: (id: string) => comments.get(id) ?? null,
    triage: (ids: string[], to: CommentState) => move(ids, to),
    undo(id: number) {
      const a = actions[id - 1];
      if (!a) throw new Error('No such action');
      for (const c of a.changes) comments.get(c.commentId)!.state = c.from;
      return { actionId: id, changes: a.changes.map((c) => ({ ...c, from: c.to, to: c.from })), counts: counts() };
    },
    markHandedOff(id: string, body: string) {
      drafts.set(id, { body, updatedAt: 'now', status: 'handed_off' });
      return move([id], 'replied');
    },
    getDraft: (id: string) => drafts.get(id) ?? null,
    putDraft(id: string, body: string) {
      const d = { body, updatedAt: 'now', status: 'draft' as const };
      drafts.set(id, d);
      return d;
    },
    deleteDraft: (id: string) => void drafts.delete(id),
    counts,
    listLabels: () => [],
  };
  sources.push({
    id: 1,
    kind: 'playlist',
    ytId: 'PLabcdefghijkl',
    title: 'P',
    thumbnailUrl: null,
    isOwn: false,
    enabled: true,
    importMode: 'recent',
    addedAt: 'x',
    videoCount: 1,
    inboxCount: 2,
    lastError: null,
    projectedUnitsPerDay: 10,
  });
  return repo;
}

const idleStatus: SyncStatus = {
  running: false,
  runId: null,
  trigger: null,
  done: 0,
  total: 0,
  currentVideoId: null,
  lastRun: null,
};

let app: FastifyInstance;
let repo: ReturnType<typeof stubRepo>;
let events: ServerEvent[];
let deps: AppDeps;
let engineRun: ReturnType<typeof vi.fn>;
let canManual = true;

beforeEach(() => {
  repo = stubRepo();
  const bus = createEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  engineRun = vi.fn(async () => ({
    id: 1,
    trigger: 'manual',
    startedAt: 'x',
    finishedAt: 'y',
    units: 0,
    videos: 0,
    newComments: 0,
    error: null,
  }));
  canManual = true;
  deps = {
    repo: repo as unknown as Repo,
    engine: { run: engineRun as never, status: () => idleStatus },
    bus,
    quota: {
      dayPt: () => '2026-01-01',
      charge() {},
      used: () => 5,
      snapshot: () => ({ dayPt: '2026-01-01', used: 5, budget: 9000, reserve: 1000, blockedUntil: null }),
      canPoll: () => true,
      canManual: () => canManual,
      blockUntilNextDay() {},
    },
    poster: createHandoffPoster(repo as unknown as Repo),
    auth: fakeGoogleAuth(),
    addSource: vi.fn(async (input: string) => ({ ...repo.listSources()[0]!, id: 2, ytId: input })),
    testKey: vi.fn(async (k: string) => ({ ok: k === 'good', message: 'm' })),
    onSettingsChanged: vi.fn(),
    resolveApiKey: () => ({ key: 'secret-key-1234', source: 'env' as const }),
    demo: true,
    demoTick: vi.fn(),
  };
  app = buildApp(deps, { pingMs: 30 });
});
afterEach(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: H.host } });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, payload: payload as never });

describe('read routes', () => {
  it('bootstrap never leaks the full key', async () => {
    const res = await get('/api/bootstrap');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.settings.apiKey).toEqual({ configured: true, source: 'env', last4: '1234' });
    expect(b.capabilities).toEqual({ canPost: false, postMode: 'handoff' });
    expect(b.counts.inbox).toBe(2);
    expect(b.sync.running).toBe(false);
    expect(res.body).not.toContain('secret-key');
  });
  it('inbox validates and returns a page', async () => {
    expect((await get('/api/inbox?view=inbox')).json().total).toBe(2);
    const badView = await get('/api/inbox?view=nope');
    expect(badView.statusCode).toBe(400);
    expect(badView.json().code).toBe('bad_request');
    expect((await get('/api/inbox?limit=0')).statusCode).toBe(400);
  });
  it('threads', async () => {
    expect((await get('/api/threads/t1')).json().threadId).toBe('t1');
    expect((await get('/api/threads/zzz')).statusCode).toBe(404);
  });
  it('sources, videos, quota, sync status', async () => {
    expect((await get('/api/sources')).json()).toHaveLength(1);
    expect((await get('/api/sources/1/videos')).json()).toHaveLength(1);
    expect((await get('/api/sources/9/videos')).statusCode).toBe(404);
    expect((await get('/api/quota')).json().used).toBe(5);
    expect((await get('/api/sync/status')).json().running).toBe(false);
  });
});

describe('triage and undo', () => {
  it('triages, emits inbox.changed, and undoes', async () => {
    const res = await send('POST', '/api/triage', { commentIds: ['c1'], to: 'done' });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.inbox).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'inbox.changed', changedIds: ['c1'] }));
    const undo = await send('POST', `/api/triage/${res.json().actionId}/undo`);
    expect(undo.json().counts.inbox).toBe(2);
    expect((await send('POST', '/api/triage/99/undo')).statusCode).toBe(409);
  });
  it('rejects bad bodies', async () => {
    expect((await send('POST', '/api/triage', { commentIds: [], to: 'done' })).statusCode).toBe(400);
    expect((await send('POST', '/api/triage', { commentIds: ['c1'], to: 'own' })).statusCode).toBe(400);
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/triage',
      headers: { ...H, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toHaveProperty('error');
  });
});

describe('drafts and reply', () => {
  it('draft lifecycle', async () => {
    expect((await get('/api/drafts/c1')).statusCode).toBe(404);
    expect((await send('PUT', '/api/drafts/c1', { body: 'hi' })).json().body).toBe('hi');
    expect((await get('/api/drafts/c1')).json().body).toBe('hi');
    expect((await send('PUT', '/api/drafts/nope', { body: 'x' })).statusCode).toBe(404);
    expect((await send('DELETE', '/api/drafts/c1')).statusCode).toBe(204);
    expect((await get('/api/drafts/c1')).statusCode).toBe(404);
  });
  it('reply hands off with permalink and actionId', async () => {
    const res = await send('POST', '/api/comments/c1/reply', { body: 'thanks!' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: 'handoff', url: 'https://www.youtube.com/watch?v=vid&lc=c1', actionId: 1 });
    expect(repo.getComment('c1')!.state).toBe('replied');
    expect((await send('POST', '/api/comments/zz/reply', { body: 'x' })).statusCode).toBe(404);
    expect((await send('POST', '/api/comments/c2/reply', { body: '  ' })).statusCode).toBe(400);
  });
});

describe('sources and videos', () => {
  it('preview, add, patch, delete', async () => {
    expect((await send('POST', '/api/sources/preview', { input: 'https://youtu.be/jNQXAC9IVRw' })).json()).toEqual({
      kind: 'video',
      ytId: 'jNQXAC9IVRw',
    });
    expect((await send('POST', '/api/sources/preview', { input: 'garbage!!' })).statusCode).toBe(400);
    const add = await send('POST', '/api/sources', { input: 'jNQXAC9IVRw', importMode: 'all' });
    expect(add.statusCode).toBe(201);
    expect(deps.addSource).toHaveBeenCalledWith('jNQXAC9IVRw', { importMode: 'all', isOwn: undefined });
    expect((await send('POST', '/api/sources', { input: 'jNQXAC9IVRw', importMode: 'bogus' })).statusCode).toBe(400);
    const patched = await send('PATCH', '/api/sources/1', { enabled: false });
    expect(patched.json().enabled).toBe(false);
    expect((await send('PATCH', '/api/sources/1', {})).statusCode).toBe(400);
    expect((await send('PATCH', '/api/sources/77', { enabled: true })).statusCode).toBe(404);
    expect(events.some((e) => e.type === 'sources.changed')).toBe(true);
    expect((await send('DELETE', '/api/sources/1?purge=1')).statusCode).toBe(204);
  });
  it('video tier override', async () => {
    expect((await send('PATCH', '/api/videos/vid', { tierOverride: 'paused' })).json().tierOverride).toBe('paused');
    expect((await send('PATCH', '/api/videos/vid', { tierOverride: null })).statusCode).toBe(200);
    expect((await send('PATCH', '/api/videos/vid', { tierOverride: 'weird' })).statusCode).toBe(400);
    expect((await send('PATCH', '/api/videos/nope', { tierOverride: null })).statusCode).toBe(404);
  });
});

describe('sync', () => {
  it('202 and kicks the engine', async () => {
    const res = await send('POST', '/api/sync', { scope: 'all' });
    expect(res.statusCode).toBe(202);
    expect(engineRun).toHaveBeenCalledWith({ trigger: 'manual', scope: 'all' });
  });
  it('validates scope/id and respects quota', async () => {
    expect((await send('POST', '/api/sync', { scope: 'video' })).statusCode).toBe(400);
    canManual = false;
    expect((await send('POST', '/api/sync', { scope: 'all' })).statusCode).toBe(429);
  });
});

describe('settings', () => {
  it('get/put; own channel change recomputes ownership and emits', async () => {
    const res = await send('PUT', '/api/settings', { ownChannelIds: [OWN], theme: 'dark', apiKey: ' abc ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().theme).toBe('dark');
    expect(repo.recomputeOwnership).toHaveBeenCalledWith([OWN]);
    expect(deps.onSettingsChanged).toHaveBeenCalled();
    expect(repo.getSettings().apiKey).toBe('abc');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['settings.changed', 'inbox.changed']));
    // unchanged own ids: no second recompute
    await send('PUT', '/api/settings', { ownChannelIds: [OWN] });
    expect(repo.recomputeOwnership).toHaveBeenCalledTimes(1);
    expect((await get('/api/settings')).json().ownChannelIds).toEqual([OWN]);
  });
  it('validates', async () => {
    expect((await send('PUT', '/api/settings', { ownChannelIds: ['nope'] })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings', { theme: 'pink' })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings', { dailyQuotaBudget: -1 })).statusCode).toBe(400);
  });
  it('test-key uses supplied or resolved key', async () => {
    expect((await send('POST', '/api/settings/test-key', { apiKey: 'good' })).json().ok).toBe(true);
    expect((await send('POST', '/api/settings/test-key', {})).json().ok).toBe(false);
    expect(deps.testKey).toHaveBeenLastCalledWith('secret-key-1234');
  });
});

describe('demo', () => {
  it('tick only exists in demo mode', async () => {
    expect((await send('POST', '/api/demo/tick')).statusCode).toBe(204);
    expect(deps.demoTick).toHaveBeenCalled();
    const other = buildApp({ ...deps, demo: false });
    expect((await other.inject({ method: 'POST', url: '/api/demo/tick', headers: H })).statusCode).toBe(404);
    await other.close();
  });
});

describe('security', () => {
  it('rejects foreign Host', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: 'evil.example:4517' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('bad_host');
  });
  it('accepts localhost', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/quota', headers: { host: 'localhost:4517' } });
    expect(r.statusCode).toBe(200);
  });
  it('rejects non-GET without header, or with foreign origin', async () => {
    const noHeader = await app.inject({
      method: 'POST',
      url: '/api/triage',
      headers: { host: H.host },
      payload: { commentIds: ['c1'], to: 'done' },
    });
    expect(noHeader.statusCode).toBe(403);
    const evil = await app.inject({
      method: 'POST',
      url: '/api/triage',
      headers: { ...H, origin: 'https://evil.example' },
      payload: { commentIds: ['c1'], to: 'done' },
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().code).toBe('bad_origin');
    expect(repo.getComment('c1')!.state).toBe('inbox');
    const same = await app.inject({
      method: 'POST',
      url: '/api/triage',
      headers: { ...H, origin: 'http://127.0.0.1:4517' },
      payload: { commentIds: ['c1'], to: 'done' },
    });
    expect(same.statusCode).toBe(200);
  });
  it('unknown api path is a JSON 404', async () => {
    const r = await get('/api/nothing');
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('not_found');
  });
});

describe('SSE', () => {
  it('streams inbox.changed after a triage, pings, and cleans up', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    };
    await readUntil('retry: 2000');
    const post = await fetch(`http://127.0.0.1:${port}/api/triage`, {
      method: 'POST',
      headers: { 'x-nudge': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ commentIds: ['c1'], to: 'done' }),
    });
    expect(post.status).toBe(200);
    await readUntil('event: inbox.changed');
    expect(text).toContain('event: inbox.changed');
    expect(text).toMatch(/data: \{"type":"inbox.changed"/);
    await readUntil(': ping');
    expect(text).toContain(': ping');
    ac.abort();
  });
});

describe('static serving', () => {
  it('serves assets and falls back to index.html for SPA routes, but not for /api', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'yt-static-'));
    writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const s = buildApp({ ...deps, staticDir: dir });
    const h = { host: H.host };
    expect((await s.inject({ url: '/app.js', headers: h })).body).toBe('console.log(1)');
    const spa = await s.inject({ url: '/sources/3', headers: h });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('spa');
    expect((await s.inject({ url: '/api/nope', headers: h })).statusCode).toBe(404);
    await s.close();
  });
});
