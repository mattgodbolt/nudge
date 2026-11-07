import { describe, expect, it, vi } from 'vitest';
import { createAddSource } from './sources.js';
import { makeEnv, ytVideo } from './test-helpers.js';
import type { SyncEngine } from '../contracts.js';

const CH = 'UCsourcetest0000000000';

function setup() {
  const env = makeEnv();
  const run = vi.fn(async () => ({
    id: 1,
    trigger: 'source-added',
    startedAt: '',
    finishedAt: '',
    units: 0,
    videos: 0,
    newComments: 0,
    error: null,
  }));
  const engine = { run, status: () => ({}) } as unknown as SyncEngine;
  const addSource = createAddSource({ repo: env.repo, yt: env.yt, engine, clock: env.clock.now });
  const day = 86_400_000;
  for (const id of ['vidAAAAAAAA', 'vidBBBBBBBB'])
    env.yt.videos.set(id, ytVideo(id, new Date(env.clock.now().getTime() - day)));
  return { env, run, addSource };
}

describe('addSource', () => {
  it('adds a video: metadata, membership, background first sync', async () => {
    const { env, run, addSource } = setup();
    const s = await addSource('https://youtu.be/vidAAAAAAAA', {});
    expect(s).toMatchObject({
      kind: 'video',
      ytId: 'vidAAAAAAAA',
      title: 'Video vidAAAAAAAA',
      importMode: 'recent',
      isOwn: false,
      videoCount: 1,
    });
    expect(env.repo.getVideoSyncRow('vidAAAAAAAA')?.baselineAt).not.toBeNull();
    expect(run).toHaveBeenCalledWith({ trigger: 'source-added', scope: 'source', id: s.id });
  });

  it('adds a playlist with batched metadata and flags unavailable entries as missing', async () => {
    const { env, addSource } = setup();
    env.yt.playlists.set('PLabcdefghijk', ['vidAAAAAAAA', 'vidBBBBBBBB', 'vidPRIVATE01']);
    const s = await addSource('https://www.youtube.com/playlist?list=PLabcdefghijk', { importMode: 'none' });
    expect(s).toMatchObject({ kind: 'playlist', title: 'Playlist PLabcdefghijk', videoCount: 3, importMode: 'none' });
    expect(env.yt.count('videos:')).toBe(1); // one batched call
    expect(env.repo.getVideoSyncRow('vidPRIVATE01')?.missing).toBe(true);
  });

  it('resolves a channel handle to its id and uploads playlist, honouring isOwn', async () => {
    const { env, addSource } = setup();
    env.yt.channels.set(CH, { id: CH, title: 'Chan', thumbnailUrl: null, uploadsPlaylistId: 'UUsourcetest0000000000' });
    env.yt.handles.set('@chan', CH);
    env.yt.playlists.set('UUsourcetest0000000000', ['vidAAAAAAAA']);
    const s = await addSource('@chan', { isOwn: true });
    expect(s).toMatchObject({ kind: 'channel', ytId: CH, isOwn: true, title: 'Chan', videoCount: 1 });
    expect(env.repo.getSourceRow(s.id)?.uploadsPlaylistId).toBe('UUsourcetest0000000000');
  });

  it('returns the existing source rather than duplicating, and does not re-sync', async () => {
    const { run, addSource } = setup();
    const a = await addSource('vidAAAAAAAA', {});
    const b = await addSource('https://www.youtube.com/watch?v=vidAAAAAAAA', {});
    expect(b.id).toBe(a.id);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects garbage and unknown things with YtError', async () => {
    const { addSource } = setup();
    await expect(addSource('not a youtube thing', {})).rejects.toMatchObject({ reason: 'badRequest' });
    await expect(addSource('vidZZZZZZZZ', {})).rejects.toMatchObject({ reason: 'notFound' });
    await expect(addSource('PLdoesnotexist1', {})).rejects.toMatchObject({ reason: 'notFound' });
    await expect(addSource('@nobody', {})).rejects.toMatchObject({ reason: 'notFound' });
  });

  it('does not let a failing background sync reject the add', async () => {
    const { run, addSource } = setup();
    run.mockRejectedValueOnce(new Error('boom'));
    await expect(addSource('vidAAAAAAAA', {})).resolves.toBeDefined();
  });
});
