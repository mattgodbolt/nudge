import { beforeEach, describe, expect, it } from 'vitest';
import type { PushPayload, PushSender, PushSendResult } from '../contracts.js';
import { makeEnv } from '../sync/test-helpers.js';
import { createPushNotifier } from './notifier.js';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let env: ReturnType<typeof makeEnv>;
let sent: { endpoint: string; payload: PushPayload }[];
let outcome: PushSendResult;
const sender: PushSender = {
  async send(sub, payload) {
    sent.push({ endpoint: sub.endpoint, payload });
    return outcome;
  },
};

function addThread(id: string, o: { videoId?: string; at?: string; author?: string; text?: string } = {}) {
  const at = o.at ?? ago(HOUR);
  env.repo.upsertThread({
    id,
    videoId: o.videoId ?? 'v1',
    channelId: 'UCchan',
    canReply: true,
    totalReplyCount: 0,
    replies: [],
    topComment: {
      id,
      parentId: null,
      videoId: o.videoId ?? 'v1',
      authorName: o.author ?? `Author ${id}`,
      authorChannelId: `UCviewer_${id}`,
      authorAvatarUrl: null,
      textHtml: o.text ?? `text of ${id}`,
      likeCount: 0,
      publishedAt: at,
      updatedAt: at,
    },
  });
}
const subscribe = (endpoint: string, prefs = { newComments: true, snoozeWake: true }) =>
  env.repo.upsertPushSubscription({ endpoint, p256dh: 'k', auth: 'a', label: null, prefs });
const arrive = (ids: string[], reason: 'sync' | 'woke' | null = 'sync') =>
  env.bus.emit({
    type: 'inbox.changed',
    counts: env.repo.counts(),
    addedIds: ids,
    changedIds: [],
    ...(reason ? { reason } : {}),
  });
const EP = 'https://fcm.googleapis.com/fcm/send/abc';

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
  env.repo.setSourceVideos(s.id, [
    { id: 'v1', position: 0 },
    { id: 'v2', position: 1 },
  ]);
  sent = [];
  outcome = 'ok';
});

function notifier(extra: Partial<Parameters<typeof createPushNotifier>[0]> = {}) {
  return createPushNotifier({ repo: env.repo, bus: env.bus, sender, publicKey: 'pub', coalesceMs: 10_000, ...extra });
}

describe('push notifier', () => {
  it('describes a single new comment by author, video and text, and opens that comment', async () => {
    subscribe(EP);
    addThread('c1', { author: 'Ada', text: 'Great   video!\nThanks' });
    const n = notifier();
    arrive(['c1']);
    await n.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      title: expect.stringContaining('Ada on '),
      body: 'Great video! Thanks',
      url: '/inbox?c=c1',
    });
    n.stop();
  });

  it('summarises several arrivals into one notification, grouped by video', async () => {
    subscribe(EP);
    env.repo.upsertVideos([
      {
        id: 'v1',
        title: 'First video',
        channelId: null,
        channelTitle: null,
        thumbnailUrl: null,
        publishedAt: null,
        viewCount: null,
        commentCount: null,
      },
      {
        id: 'v2',
        title: 'Second video',
        channelId: null,
        channelTitle: null,
        thumbnailUrl: null,
        publishedAt: null,
        viewCount: null,
        commentCount: null,
      },
    ]);
    for (const id of ['c1', 'c2', 'c3']) addThread(id, { videoId: id === 'c3' ? 'v2' : 'v1' });
    const n = notifier();
    arrive(['c1']);
    arrive(['c2', 'c3']);
    await n.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.title).toBe('3 new comments');
    expect(sent[0]!.payload.url).toBe('/inbox');
    expect(sent[0]!.payload.body).toBe('First video (2), Second video (1)');
    n.stop();
  });

  it('ignores events without a reason (undo, triage) and sends nothing with no subscribers', async () => {
    addThread('c1');
    const n = notifier();
    arrive(['c1']);
    await n.flush();
    expect(sent).toHaveLength(0);

    subscribe(EP);
    arrive(['c1'], null);
    await n.flush();
    expect(sent).toHaveLength(0);
    n.stop();
  });

  it('skips old comments (backfill) and ones that were triaged in the meantime', async () => {
    subscribe(EP);
    addThread('old', { at: ago(10 * 24 * HOUR) });
    addThread('done');
    addThread('fresh');
    env.repo.triage(['done'], 'done');
    const n = notifier();
    arrive(['old', 'done', 'fresh']);
    await n.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.url).toBe('/inbox?c=fresh');
    n.stop();
  });

  it('respects each device’s preferences', async () => {
    subscribe('https://fcm.googleapis.com/fcm/send/new-only', { newComments: true, snoozeWake: false });
    subscribe('https://fcm.googleapis.com/fcm/send/wake-only', { newComments: false, snoozeWake: true });
    addThread('c1');
    const n = notifier();
    arrive(['c1']);
    await n.flush();
    expect(sent.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/new-only']);

    sent = [];
    arrive(['c1'], 'woke');
    await n.flush();
    expect(sent.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/wake-only']);
    expect(sent[0]!.payload.title).toMatch(/^Snoozed: /);
    n.stop();
  });

  it('notifies about woken comments even when they are old', async () => {
    subscribe(EP);
    addThread('old', { at: ago(30 * 24 * HOUR) });
    const n = notifier();
    arrive(['old'], 'woke');
    await n.flush();
    expect(sent).toHaveLength(1);
    n.stop();
  });

  it('sends on its own after the coalescing window (woke immediately)', async () => {
    subscribe(EP);
    addThread('c1');
    const n = notifier({ coalesceMs: 20 });
    arrive(['c1']);
    expect(sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    await n.flush();
    expect(sent).toHaveLength(1);
    n.stop();
  });

  it('drops a subscription the push service says is gone, and after repeated failures', async () => {
    subscribe(EP);
    addThread('c1');
    const n = notifier({ maxFailures: 2 });
    outcome = 'gone';
    arrive(['c1']);
    await n.flush();
    expect(env.repo.listPushSubscriptions()).toHaveLength(0);

    subscribe(EP);
    outcome = 'error';
    arrive(['c1']);
    await n.flush();
    expect(env.repo.getPushSubscription(EP)?.failureCount).toBe(1);
    arrive(['c1']);
    await n.flush();
    expect(env.repo.listPushSubscriptions()).toHaveLength(0);
    n.stop();
  });

  it('test() reports unknown devices and delivers to known ones', async () => {
    const n = notifier();
    expect(await n.test(EP)).toBe('unknown');
    subscribe(EP);
    expect(await n.test(EP)).toBe('ok');
    expect(sent[0]!.payload.tag).toBe('nudge-test');
    n.stop();
  });
});

describe('GitHub arrivals', () => {
  const ghItem = (n: number, o: Record<string, unknown> = {}) => ({
    id: `gh:org/app#${n}`,
    kind: 'pr' as const,
    repo: 'org/app',
    number: n,
    title: `Change ${n}`,
    author: 'carol',
    authorAvatarUrl: null,
    authorType: 'User',
    association: 'CONTRIBUTOR' as const,
    bodyPlain: '',
    url: `https://github.com/org/app/pull/${n}`,
    createdAt: ago(HOUR),
    updatedAt: ago(HOUR),
    sourceState: 'open' as const,
    draft: false,
    comments: 0,
    labels: [],
    ...o,
  });
  let feedId: number;
  beforeEach(() => {
    // Baseline far in the past so items created an hour ago land in the inbox.
    feedId = env.repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' }).id;
  });

  it('describes one new pull request by repo, title and author, and links straight to it', async () => {
    subscribe(EP);
    const n = notifier();
    const r = env.repo.upsertGithubItems(feedId, [ghItem(1)]);
    arrive(r.added);
    await n.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({
      title: 'New pull request in org/app',
      body: 'Change 1 (by carol)',
      url: '/inbox?c=gh%3Aorg%2Fapp%231',
      tag: 'nudge-new-gh:org/app#1',
    });
    n.stop();
  });

  it('summarises a mixed batch of comments and GitHub items by container', async () => {
    subscribe(EP);
    const n = notifier();
    addThread('c1');
    const r = env.repo.upsertGithubItems(feedId, [ghItem(1), ghItem(2, { kind: 'issue' })]);
    arrive(['c1', ...r.added]);
    await n.flush();
    expect(sent[0]!.payload.title).toBe('3 new items');
    expect(sent[0]!.payload.body).toContain('org/app (2)');
    n.stop();
  });

  it('says "activity" for a reopened thread even when it is old, and skips muted or already-handled items', async () => {
    subscribe(EP);
    const n = notifier();
    const old = ghItem(1, { createdAt: ago(30 * 24 * HOUR) });
    env.repo.upsertGithubItems(feedId, [old]);
    env.repo.triage([old.id], 'done');
    const r = env.repo.upsertGithubItems(feedId, [{ ...old, comments: 2 }]);
    arrive(r.reopened);
    await n.flush();
    expect(sent[0]!.payload.title).toBe('Activity on org/app#1');

    sent = [];
    const muted = ghItem(2);
    env.repo.addMuteRule('item', muted.id);
    const r2 = env.repo.upsertGithubItems(feedId, [muted]);
    arrive([...r2.added, muted.id]);
    await n.flush();
    expect(sent).toEqual([]);
    n.stop();
  });

  it('does not announce a new item whose creation is older than the freshness window', async () => {
    subscribe(EP);
    const n = notifier();
    const r = env.repo.upsertGithubItems(feedId, [ghItem(1, { createdAt: ago(5 * 24 * HOUR) })]);
    arrive(r.added);
    await n.flush();
    expect(sent).toEqual([]);
    n.stop();
  });
});
