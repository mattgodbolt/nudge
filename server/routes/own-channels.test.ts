import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { SyncEngine } from '../contracts.js';
import { createAddSource } from '../sync/sources.js';
import { makeEnv } from '../sync/test-helpers.js';
import type { SettingsDTO } from '../../shared/types.js';
import { H, testDeps } from './test-helpers.js';

// Real repo + real addSource against a scripted YouTube client: exercises the whole "this is my channel" flow.
const CH = 'UC' + 'm'.repeat(22);

let app: FastifyInstance;
let env: ReturnType<typeof makeEnv>;
let engineRun: ReturnType<typeof vi.fn>;

beforeEach(() => {
  env = makeEnv({ settings: { ownChannelIds: [] } });
  env.yt.channels.set(CH, { id: CH, title: 'My Channel', thumbnailUrl: 'http://t/x.jpg', uploadsPlaylistId: 'UUmine' });
  env.yt.handles.set('@mychannel', CH);
  env.yt.playlists.set('UUmine', []);
  engineRun = vi.fn(async () => ({}));
  const engine = { run: engineRun, status: () => ({}) } as unknown as SyncEngine;
  app = buildApp(
    testDeps(env.repo, {
      bus: env.bus,
      quota: env.quota,
      engine,
      addSource: createAddSource({ repo: env.repo, yt: env.yt, engine, clock: env.clock.now }),
    }),
  );
});
afterEach(() => app.close());

const add = (input: unknown) =>
  app.inject({ method: 'POST', url: '/api/settings/own-channels', headers: H, payload: { input } as never });

describe('POST /api/settings/own-channels', () => {
  const expectMine = (dto: SettingsDTO) => {
    expect(dto.ownChannelIds).toEqual([CH]);
    expect(dto.ownChannels).toEqual([{ id: CH, title: 'My Channel', thumbnailUrl: 'http://t/x.jpg' }]);
    expect(env.repo.listSources()).toMatchObject([{ kind: 'channel', ytId: CH, isOwn: true }]);
  };

  it.each([
    ['an @handle', '@mychannel'],
    ['a handle URL', 'https://www.youtube.com/@mychannel'],
    ['a /channel/UC URL', `https://www.youtube.com/channel/${CH}`],
    ['a bare UC id', CH],
  ])('resolves %s', async (_name, input) => {
    const res = await add(input);
    expect(res.statusCode).toBe(200);
    expectMine(res.json());
  });

  it('is idempotent', async () => {
    await add('@mychannel');
    const res = await add(CH);
    expect(res.statusCode).toBe(200);
    expectMine(res.json());
    expect(engineRun).toHaveBeenCalledTimes(1);
  });

  it('flips an already-tracked, non-own channel to mine', async () => {
    env.repo.addSource({
      kind: 'channel',
      ytId: CH,
      title: 'My Channel',
      thumbnailUrl: 'http://t/x.jpg',
      isOwn: false,
      importMode: 'recent',
    });
    expectMine((await add('@mychannel')).json());
  });

  it('404s on an unknown channel and registers nothing', async () => {
    const res = await add('@nobodyhere');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('notFound');
    expect(env.repo.getSettings().ownChannelIds).toEqual([]);
  });

  it('400s on things that are not a channel', async () => {
    expect((await add('https://youtu.be/jNQXAC9IVRw')).statusCode).toBe(400);
    expect((await add('rubbish!!')).statusCode).toBe(400);
    expect((await add('')).statusCode).toBe(400);
  });

  it('keeps PATCH /api/sources/:id isOwn consistent with the registered ids', async () => {
    await add('@mychannel');
    const id = env.repo.listSources()[0]!.id;
    await app.inject({ method: 'PATCH', url: `/api/sources/${id}`, headers: H, payload: { isOwn: false } });
    expect(env.repo.getSettings().ownChannelIds).toEqual([]);
    await app.inject({ method: 'PATCH', url: `/api/sources/${id}`, headers: H, payload: { isOwn: true } });
    expect(env.repo.getSettings().ownChannelIds).toEqual([CH]);
  });
});

describe('DELETE /api/settings/own-channels/:id', () => {
  it('un-marks the source but keeps tracking it', async () => {
    await add('@mychannel');
    const res = await app.inject({ method: 'DELETE', url: `/api/settings/own-channels/${CH}`, headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownChannelIds).toEqual([]);
    expect(env.repo.listSources()).toMatchObject([{ ytId: CH, isOwn: false }]);
  });
});

describe('PUT /api/settings ownChannelIds', () => {
  it('recomputes ownership once (in the repo), not again in the route, and still flips the source flag', async () => {
    await add('@mychannel');
    // The repo's own recompute calls its internal function; only a second, redundant pass goes through this property.
    const spy = vi.spyOn(env.repo, 'recomputeOwnership');
    const res = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { ownChannelIds: [] } });
    expect(res.statusCode).toBe(200);
    expect(env.repo.getSettings().ownChannelIds).toEqual([]);
    expect(env.repo.listSources()).toMatchObject([{ kind: 'channel', ytId: CH, isOwn: false }]);
    expect(spy).not.toHaveBeenCalled();
  });
});
