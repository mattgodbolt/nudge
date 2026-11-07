import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, testKey } from './client.js';
import { YtError, type QuotaTracker } from '../contracts.js';
import threadsPage from './fixtures/threads-page.json' with { type: 'json' };
import repliesPage from './fixtures/replies-page.json' with { type: 'json' };
import commentsDisabled from './fixtures/error-comments-disabled.json' with { type: 'json' };
import quotaErr from './fixtures/error-quota.json' with { type: 'json' };
import keyInvalid from './fixtures/error-key-invalid.json' with { type: 'json' };
import notFound from './fixtures/error-video-not-found.json' with { type: 'json' };
import videos from './fixtures/videos.json' with { type: 'json' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(responses: (Response | Error)[] | ((url: URL) => Response), key: string | null = '  KEY123\n') {
  const urls: URL[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    if (typeof responses === 'function') return responses(url);
    const r = responses[Math.min(i++, responses.length - 1)] as Response | Error;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  const charged: [string, number][] = [];
  const quota = { charge: (e: string, u: number) => charged.push([e, u]) } as unknown as QuotaTracker;
  const sleeps: number[] = [];
  const client = createHttpClient({
    getApiKey: () => key,
    quota,
    fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
  });
  return { client, urls, charged, sleeps, fetchImpl };
}

describe('listCommentThreads', () => {
  it('builds the request and normalises threads', async () => {
    const { client, urls, charged } = setup([json(threadsPage)]);
    const page = await client.listCommentThreads({ videoId: 'vid00000001', pageToken: 'TOK' });
    const u = urls[0] as URL;
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/youtube/v3/commentThreads');
    expect(u.searchParams.get('key')).toBe('KEY123'); // trimmed
    expect(u.searchParams.get('part')).toBe('snippet,replies');
    expect(u.searchParams.get('videoId')).toBe('vid00000001');
    expect(u.searchParams.get('order')).toBe('time');
    expect(u.searchParams.get('maxResults')).toBe('100');
    expect(u.searchParams.get('textFormat')).toBe('html');
    expect(u.searchParams.get('pageToken')).toBe('TOK');
    expect(u.searchParams.get('fields')).toContain('totalReplyCount');
    expect(charged).toEqual([['commentThreads', 1]]);

    expect(page.nextPageToken).toBe('NEXT1');
    const [t1, t2] = page.items;
    expect(t1).toMatchObject({
      id: 'UgzTop1',
      videoId: 'vid00000001',
      channelId: 'UCchan',
      canReply: true,
      totalReplyCount: 7,
    });
    expect(t1?.topComment).toMatchObject({
      id: 'UgzTop1',
      parentId: null,
      authorName: 'Alice',
      authorChannelId: 'UCalice',
      likeCount: 3,
      authorAvatarUrl: 'https://example.com/a.jpg',
      publishedAt: '2026-03-01T10:00:00Z',
    });
    expect(t1?.topComment.textHtml).toContain('<br>');
    expect(t1?.replies).toHaveLength(1);
    expect(t1?.replies[0]).toMatchObject({ id: 'UgzTop1.r1', parentId: 'UgzTop1', videoId: 'vid00000001' });
    expect(t2).toMatchObject({ canReply: false, totalReplyCount: 0, replies: [] });
    expect(t2?.topComment.authorChannelId).toBeNull();
  });

  it('uses allThreadsRelatedToChannelId for the channel feed (and no videoId)', async () => {
    const { client, urls } = setup([json({ items: [] })]);
    await client.listCommentThreads({ allThreadsRelatedToChannelId: 'UCchan' });
    const u = urls[0] as URL;
    expect(u.searchParams.get('allThreadsRelatedToChannelId')).toBe('UCchan');
    expect(u.searchParams.has('videoId')).toBe(false);
  });
});

describe('other endpoints', () => {
  it('listReplies', async () => {
    const { client, urls } = setup([json(repliesPage)]);
    const page = await client.listReplies({ parentId: 'UgzTop1', pageToken: 'P2' });
    const u = urls[0] as URL;
    expect(u.pathname.endsWith('/comments')).toBe(true);
    expect(u.searchParams.get('parentId')).toBe('UgzTop1');
    expect(u.searchParams.get('maxResults')).toBe('100');
    expect(u.searchParams.get('pageToken')).toBe('P2');
    expect(page.items[0]).toMatchObject({ id: 'UgzTop1.r1', parentId: 'UgzTop1', authorChannelId: 'UCbob' });
  });

  it('getVideos batches 50 ids per call and parses stats', async () => {
    const { client, urls, charged } = setup([json(videos)]);
    const ids = Array.from({ length: 120 }, (_, i) => `v${String(i).padStart(10, '0')}`);
    const out = await client.getVideos(ids);
    expect(urls).toHaveLength(3);
    expect((urls[0] as URL).searchParams.get('id')?.split(',')).toHaveLength(50);
    expect((urls[2] as URL).searchParams.get('id')?.split(',')).toHaveLength(20);
    expect(charged).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: 'vid00000001',
      title: 'Hello',
      viewCount: 12345,
      commentCount: 67,
      thumbnailUrl: 'https://example.com/m.jpg',
    });
    expect(await setup([]).client.getVideos([])).toEqual([]);
  });

  it('getChannel by handle / id, listPlaylistItems, getPlaylist', async () => {
    const s = setup((url) => {
      if (url.pathname.endsWith('/channels'))
        return json({
          items: [{ id: 'UCx', snippet: { title: 'X' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }],
        });
      if (url.pathname.endsWith('/playlistItems'))
        return json({ nextPageToken: 'n', items: [{ snippet: { position: 2, resourceId: { videoId: 'abc' } } }] });
      return json({ items: [] });
    });
    expect(await s.client.getChannel({ handle: '@x' })).toEqual({
      id: 'UCx',
      title: 'X',
      thumbnailUrl: null,
      uploadsPlaylistId: 'UUx',
    });
    expect((s.urls[0] as URL).searchParams.get('forHandle')).toBe('@x');
    await s.client.getChannel({ id: 'UCx' });
    expect((s.urls[1] as URL).searchParams.get('id')).toBe('UCx');
    expect(await s.client.listPlaylistItems({ playlistId: 'PL1' })).toEqual({
      items: [{ videoId: 'abc', position: 2 }],
      nextPageToken: 'n',
    });
    expect((s.urls[2] as URL).searchParams.get('maxResults')).toBe('50');
    expect(await s.client.getPlaylist('PLnone')).toBeNull();
  });
});

describe('errors', () => {
  const reasonFor = async (res: Response) => {
    const { client } = setup([res]);
    const e = await client.listCommentThreads({ videoId: 'v' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(YtError);
    return (e as YtError).reason;
  };
  it('maps API errors to YtError reasons', async () => {
    expect(await reasonFor(json(commentsDisabled, 403))).toBe('commentsDisabled');
    expect(await reasonFor(json(quotaErr, 403))).toBe('quotaExceeded');
    expect(await reasonFor(json(notFound, 404))).toBe('notFound');
    expect(await reasonFor(json(keyInvalid, 400))).toBe('keyInvalid');
    expect(await reasonFor(json({ error: { code: 403, message: 'no', errors: [{ reason: 'forbidden' }] } }, 403))).toBe(
      'forbidden',
    );
    expect(
      await reasonFor(json({ error: { code: 400, message: 'bad', errors: [{ reason: 'processingFailure' }] } }, 400)),
    ).toBe('badRequest');
    expect(await reasonFor(json({ error: { code: 418, message: 'teapot' } }, 418))).toBe('unknown');
  });
  it('does not retry client errors, and charges once', async () => {
    const s = setup([json(quotaErr, 403)]);
    await expect(s.client.listCommentThreads({ videoId: 'v' })).rejects.toMatchObject({ reason: 'quotaExceeded' });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.charged).toHaveLength(1);
  });
  it('throws keyInvalid without calling out when no key is configured', async () => {
    const s = setup([json({})], null);
    await expect(s.client.getVideos(['abcdefghijk'])).rejects.toMatchObject({ reason: 'keyInvalid' });
    expect(s.fetchImpl).not.toHaveBeenCalled();
    expect(s.charged).toHaveLength(0);
  });
});

describe('retries', () => {
  it('retries 500 then succeeds, with 1s backoff, charging once', async () => {
    const s = setup([json({ error: { code: 500, message: 'boom' } }, 500), json(threadsPage)]);
    const page = await s.client.listCommentThreads({ videoId: 'v' });
    expect(page.items).toHaveLength(2);
    expect(s.fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.sleeps).toEqual([1000]);
    expect(s.charged).toHaveLength(1);
  });
  it('backs off 1s, 2s, 4s on network errors and then gives up with reason network', async () => {
    const s = setup([new Error('ECONNRESET')]);
    await expect(s.client.getVideos(['abcdefghijk'])).rejects.toMatchObject({ reason: 'network' });
    expect(s.fetchImpl).toHaveBeenCalledTimes(4);
    expect(s.sleeps).toEqual([1000, 2000, 4000]);
  });
  it('gives up on persistent 503s with reason unknown', async () => {
    const s = setup([json({ error: { code: 503, message: 'down' } }, 503)]);
    await expect(s.client.getVideos(['abcdefghijk'])).rejects.toMatchObject({ reason: 'unknown', status: 503 });
    expect(s.sleeps).toHaveLength(3);
  });
  it('adds jitter to the delay', async () => {
    const sleeps: number[] = [];
    const client = createHttpClient({
      getApiKey: () => 'k',
      quota: { charge() {} } as unknown as QuotaTracker,
      random: () => 1,
      sleep: async (ms) => void sleeps.push(ms),
      fetchImpl: vi.fn().mockRejectedValue(new Error('x')) as unknown as typeof fetch,
    });
    await client.getVideos(['abcdefghijk']).catch(() => {});
    expect(sleeps.every((ms, i) => ms > 1000 * 2 ** i)).toBe(true);
  });
});

describe('concurrency', () => {
  it('never has more than 4 requests in flight', async () => {
    let inFlight = 0;
    let max = 0;
    const fetchImpl = (async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return json({ items: [] });
    }) as unknown as typeof fetch;
    const client = createHttpClient({
      getApiKey: () => 'k',
      quota: { charge() {} } as unknown as QuotaTracker,
      fetchImpl,
    });
    await Promise.all(Array.from({ length: 12 }, () => client.getPlaylist('PLx')));
    expect(max).toBe(4);
  });
});

describe('testKey', () => {
  it('ok on 200, using a 1-unit videos.list call and a trimmed key', async () => {
    let url = '';
    const f = (async (u: string) => ((url = u), json({ items: [{ id: 'jNQXAC9IVRw' }] }))) as unknown as typeof fetch;
    expect(await testKey(' abc \n', f)).toEqual({ ok: true, message: expect.any(String) });
    expect(url).toContain('/videos?');
    expect(url).toContain('id=jNQXAC9IVRw');
    expect(url).toContain('key=abc');
  });
  it('reports invalid keys, network failures and empty input without leaking the key', async () => {
    const bad = (async () => json(keyInvalid, 400)) as unknown as typeof fetch;
    expect(await testKey('nope', bad)).toMatchObject({
      ok: false,
      message: expect.stringContaining('API key not valid'),
    });
    const down = (async () => {
      throw new Error('getaddrinfo secret123');
    }) as unknown as typeof fetch;
    const r = await testKey('secret123', down);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain('secret123');
    expect((await testKey('  ')).ok).toBe(false);
  });
});
