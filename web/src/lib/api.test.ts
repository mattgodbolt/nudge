import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, retry } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api retries', () => {
  const original = [...retry.delaysMs];
  beforeEach(() => {
    retry.delaysMs = [0, 0, 0];
  });
  afterEach(() => {
    retry.delaysMs = original;
    vi.unstubAllGlobals();
  });

  it('rides out a restart: a read that gets 502 then succeeds returns the data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.bootstrap()).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last delay and reports the error', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('nope', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.bootstrap()).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry real errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(400, { error: 'bad', code: 'bad_request' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.bootstrap()).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries a write', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.deleteReply('c1')).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
