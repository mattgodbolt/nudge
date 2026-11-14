import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedDTO } from '../../../../shared/types';
import { feeds } from './feeds.svelte';

const feed = (over: Partial<FeedDTO> = {}): FeedDTO => ({
  id: 1,
  provider: 'github',
  owner: 'org',
  kind: 'owner',
  ownerType: null,
  prs: true,
  issues: true,
  enabled: true,
  importMode: 'none',
  addedAt: 'x',
  lastPolledAt: null,
  nextPollAt: null,
  lastError: null,
  rate: null,
  inboxCount: 0,
  itemCount: 0,
  ...over,
});

beforeEach(() => feeds.set([], []));
afterEach(() => vi.unstubAllGlobals());

describe('feeds store', () => {
  it('does not overwrite a newer feed (with its first poll error) that arrived before the add response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // The event stream delivered the polled feed while the POST was still in flight.
        feeds.set([feed({ lastError: 'no such owner' })], []);
        return new Response(JSON.stringify(feed()), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    expect(await feeds.add('org', { prs: true, issues: true, importMode: 'none' })).toBe(true);
    expect(feeds.list).toHaveLength(1);
    expect(feeds.list[0]!.lastError).toBe('no such owner');
  });

  it('adds a feed that the event stream has not mentioned yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(feed({ id: 7 })), { status: 201 })),
    );
    await feeds.add('org', { prs: true, issues: true, importMode: 'none' });
    expect(feeds.list.map((f) => f.id)).toEqual([7]);
  });

  it('shows the server message when adding fails, and keeps the list unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'org is already a feed', code: 'duplicate_feed' }), { status: 409 }),
      ),
    );
    expect(await feeds.add('org', { prs: true, issues: true, importMode: 'none' })).toBe(false);
    expect(feeds.list).toEqual([]);
  });
});
