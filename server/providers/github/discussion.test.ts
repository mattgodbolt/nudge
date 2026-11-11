import { describe, expect, it } from 'vitest';
import type { GithubClient } from '../../contracts.js';
import { GithubError } from '../../contracts.js';
import { createDiscussionService } from './discussion.js';

const target = {
  id: 'gh:org/app#7',
  repo: 'org/app',
  number: 7,
  kind: 'pr' as const,
  comments: 2,
  sourceState: 'open',
};

function setup(impl?: () => Promise<{ entries: []; olderCut: boolean }>) {
  let calls = 0;
  let now = 1_000_000;
  const client = {
    async discussion() {
      calls++;
      return impl ? impl() : { entries: [], olderCut: false };
    },
  } as unknown as GithubClient;
  const svc = createDiscussionService({ client, getToken: () => 'tok', clock: () => now });
  return { svc, calls: () => calls, advance: (ms: number) => (now += ms) };
}

describe('discussion service', () => {
  it('serves a repeat from the cache for a few minutes, then asks again', async () => {
    const s = setup();
    await s.svc.get(target);
    await s.svc.get(target);
    expect(s.calls()).toBe(1);
    s.advance(4 * 60_000);
    await s.svc.get(target);
    expect(s.calls()).toBe(2);
  });

  it('a changed comment count or state is a different cache entry', async () => {
    const s = setup();
    await s.svc.get(target);
    await s.svc.get({ ...target, comments: 3 });
    await s.svc.get({ ...target, sourceState: 'closed' });
    expect(s.calls()).toBe(3);
  });

  it('stops calling GitHub until the rate limit window reopens', async () => {
    const reset = new Date(1_000_000 + 60_000).toISOString();
    let limited = true;
    const s = setup(async () => {
      if (limited) throw new GithubError('rate limited', 403, reset);
      return { entries: [], olderCut: false };
    });
    await expect(s.svc.get(target)).rejects.toMatchObject({ status: 403 });
    await expect(s.svc.get({ ...target, id: 'gh:org/app#8' })).rejects.toMatchObject({ status: 429 });
    expect(s.calls()).toBe(1);
    limited = false;
    s.advance(61_000);
    await s.svc.get(target);
    expect(s.calls()).toBe(2);
  });

  it('does not cache failures', async () => {
    let fail = true;
    const s = setup(async () => {
      if (fail) throw new GithubError('down', 500);
      return { entries: [], olderCut: false };
    });
    await expect(s.svc.get(target)).rejects.toThrow('down');
    fail = false;
    await s.svc.get(target);
    expect(s.calls()).toBe(2);
  });
});
