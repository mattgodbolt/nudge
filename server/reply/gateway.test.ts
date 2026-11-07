import { describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../contracts.js';
import { createHttpPostGateway } from './gateway.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RAW = {
  id: 'c1',
  snippet: {
    parentId: 't1',
    authorDisplayName: 'Me',
    authorChannelId: { value: 'UCme' },
    textDisplay: 'hi',
    publishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

describe('http post gateway', () => {
  it('insertReply: POST with Bearer, JSON body, no key param', async () => {
    const f = vi.fn(async () => json(200, RAW));
    const c = await createHttpPostGateway({ fetchImpl: f as never }).insertReply('TOK', {
      parentId: 't1',
      videoId: 'v',
      text: 'hi',
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/youtube/v3/comments?part=snippet');
    expect(url).not.toMatch(/key=/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOK');
    expect(JSON.parse(init.body as string)).toEqual({ snippet: { parentId: 't1', textOriginal: 'hi' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(c).toMatchObject({ id: 'c1', parentId: 't1', videoId: 'v', authorChannelId: 'UCme' });
  });

  it('parses Google error JSON into status and reason', async () => {
    const f = async () => json(403, { error: { code: 403, message: 'Quota', errors: [{ reason: 'quotaExceeded' }] } });
    await expect(
      createHttpPostGateway({ fetchImpl: f as never }).insertReply('T', { parentId: 'p', videoId: 'v', text: 'x' }),
    ).rejects.toMatchObject({
      name: 'GatewayError',
      status: 403,
      reason: 'quotaExceeded',
      message: 'Quota',
      network: false,
    });
  });

  it('non-JSON error bodies still give a GatewayError', async () => {
    const f = async () => new Response('<html>', { status: 502 });
    await expect(createHttpPostGateway({ fetchImpl: f as never }).deleteComment('T', 'c')).rejects.toMatchObject({
      status: 502,
      reason: null,
    });
  });

  it('timeouts and connection errors are network:true, keeping the errno', async () => {
    const timeout = async () => {
      throw new DOMException('t', 'TimeoutError');
    };
    await expect(
      createHttpPostGateway({ fetchImpl: timeout as never }).listReplies('T', 'p', 'v'),
    ).rejects.toMatchObject({ network: true, reason: 'timeout', status: 0 });
    const refused = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    const e = await createHttpPostGateway({ fetchImpl: refused as never })
      .myChannel('T')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayError);
    expect(e).toMatchObject({ network: true, reason: 'ECONNREFUSED' });
  });

  it('listReplies, deleteComment and myChannel hit the right endpoints', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(200, { items: [RAW] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json(200, { items: [{ id: 'UCme', snippet: { title: 'Me', thumbnails: { default: { url: 'u' } } } }] }),
      );
    const g = createHttpPostGateway({ fetchImpl: f as never });
    expect(await g.listReplies('T', 't1', 'v')).toHaveLength(1);
    await g.deleteComment('T', 'c1');
    expect(await g.myChannel('T')).toEqual({ id: 'UCme', title: 'Me', thumbnailUrl: 'u' });
    const urls = f.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/comments?part=snippet&parentId=t1&maxResults=20');
    expect(urls[1]).toBe('https://www.googleapis.com/youtube/v3/comments?id=c1');
    expect(f.mock.calls[1]![1].method).toBe('DELETE');
    expect(urls[2]).toContain('/channels?part=snippet&mine=true');
  });
});
