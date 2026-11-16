import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { GithubItemUpsert, Repo, YtComment, YtThread } from '../contracts.js';
import { createEvents, exportEventsJsonl, type ItemEventRow } from './events.js';
import { githubItemId } from './feeds.js';
import { openDb, migrate, type Db } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { createRepo } from './repo.js';

const OWN = 'UCown';
let nowMs = Date.parse('2026-11-08T12:00:00.000Z');
const clock = () => new Date(nowMs);
const advance = (ms: number) => {
  nowMs += ms;
};
const HOUR = 3_600_000;

let db: Db;
let repo: Repo;

type Ev = Pick<ItemEventRow, 'itemId' | 'kind' | 'from' | 'to' | 'source'> & { meta: Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
const events = (itemId?: string): Ev[] =>
  (
    db
      .prepare(
        `SELECT item_id, kind, from_value, to_value, source, meta FROM item_events
          ${itemId === undefined ? '' : 'WHERE item_id = @itemId'} ORDER BY id`,
      )
      .all(itemId === undefined ? {} : { itemId }) as Record<string, any>[]
  ) // eslint-disable-line @typescript-eslint/no-explicit-any
    .map((r) => ({
      itemId: r.item_id,
      kind: r.kind,
      from: r.from_value,
      to: r.to_value,
      source: r.source,
      meta: r.meta ? JSON.parse(r.meta) : null,
    }));
const count = () => (db.prepare('SELECT COUNT(*) AS n FROM item_events').get() as { n: number }).n;

function cmt(id: string, o: Partial<YtComment> = {}): YtComment {
  const t = new Date(nowMs - HOUR).toISOString();
  return {
    id,
    parentId: null,
    videoId: 'vid1',
    authorName: `Author ${id}`,
    authorChannelId: `UCa_${id}`,
    authorAvatarUrl: null,
    textHtml: `text of ${id}`,
    likeCount: 0,
    publishedAt: t,
    updatedAt: t,
    ...o,
  };
}
function thread(id: string, replies: Partial<YtComment>[] = []): YtThread {
  const topComment = cmt(id);
  return {
    id,
    videoId: 'vid1',
    channelId: 'UCchan',
    canReply: true,
    topComment,
    totalReplyCount: replies.length,
    replies: replies.map((r) => cmt(r.id!, { parentId: id, ...r })),
  };
}

beforeEach(() => {
  nowMs = Date.parse('2026-11-08T12:00:00.000Z');
  db = openDb(':memory:');
  repo = createRepo(db, clock);
  const s = repo.addSource({
    kind: 'playlist',
    ytId: 'PLx',
    title: 'P',
    thumbnailUrl: null,
    isOwn: false,
    importMode: 'all',
  });
  repo.setSourceVideos(s.id, [{ id: 'vid1', position: 0 }]);
});

describe('first sight', () => {
  it('writes no events for newly imported items, however many', () => {
    for (let i = 0; i < 50; i++) repo.upsertThread(thread(`t${i}`));
    expect(repo.counts().inbox).toBe(50);
    expect(count()).toBe(0);
  });
});

describe('state events', () => {
  beforeEach(() => repo.upsertThread(thread('c1')));

  it('a dismissal is a done state event whose meta says so', () => {
    advance(HOUR);
    const r = repo.triage(['c1'], 'done', 'no_action');
    expect(events()).toEqual([
      {
        itemId: 'c1',
        kind: 'state',
        from: 'inbox',
        to: 'done',
        source: 'user',
        meta: { actionId: r.actionId, reason: 'no_action', threadSize: 0 },
      },
    ]);
  });

  it('triage writes a user state event per changed item, with the action id', () => {
    advance(HOUR);
    const r = repo.triage(['c1', 'c1', 'missing'], 'done');
    expect(events()).toEqual([
      {
        itemId: 'c1',
        kind: 'state',
        from: 'inbox',
        to: 'done',
        source: 'user',
        meta: { actionId: r.actionId, reason: 'done', threadSize: 0 },
      },
    ]);
    expect((db.prepare('SELECT at FROM item_events').get() as { at: string }).at).toBe(new Date(nowMs).toISOString());
  });

  it('writes nothing for a triage that changes nothing', () => {
    repo.triage(['c1'], 'inbox');
    expect(count()).toBe(0);
  });

  it('moving back to the inbox also records the snooze it cancels', () => {
    repo.snooze(['c1'], '2026-11-20T09:00:00.000Z');
    repo.triage(['c1'], 'done');
    repo.triage(['c1'], 'inbox');
    // done keeps the snooze; going back to the inbox drops it
    expect(events().map((e) => [e.kind, e.from, e.to])).toEqual([
      ['snooze', null, '2026-11-20T09:00:00.000Z'],
      ['state', 'inbox', 'done'],
      ['state', 'done', 'inbox'],
      ['snooze', '2026-11-20T09:00:00.000Z', null],
    ]);
  });

  it('undo writes a compensating event pointing at the original and keeps the original', () => {
    const r = repo.triage(['c1'], 'archived');
    advance(HOUR);
    repo.undo(r.actionId);
    const [orig, undo] = events();
    expect(orig).toMatchObject({ kind: 'state', to: 'archived' });
    expect(undo).toMatchObject({ kind: 'undo', from: 'archived', to: 'inbox', source: 'user' });
    const origId = (db.prepare("SELECT id FROM item_events WHERE kind = 'state'").get() as { id: number }).id;
    expect(undo!.meta).toEqual({ actionId: r.actionId, original: 'state', originalEventId: origId });
    expect(count()).toBe(2);
  });

  it('undo records nothing for items that had already moved on', () => {
    const r = repo.triage(['c1'], 'archived');
    repo.triage(['c1'], 'done');
    repo.undo(r.actionId);
    expect(events().filter((e) => e.kind === 'undo')).toEqual([]);
  });
});

describe('snooze events', () => {
  beforeEach(() => repo.upsertThread(thread('c1')));

  it('snooze, change, unsnooze and undo are recorded as user events', () => {
    const a = repo.snooze(['c1'], '2026-11-20T09:00:00.000Z');
    repo.snooze(['c1'], '2026-11-21T09:00:00.000Z');
    const b = repo.snooze(['c1'], null);
    repo.undoSnooze(b.actionId!);
    expect(events().map((e) => [e.kind, e.from, e.to, e.source])).toEqual([
      ['snooze', null, '2026-11-20T09:00:00.000Z', 'user'],
      ['snooze', '2026-11-20T09:00:00.000Z', '2026-11-21T09:00:00.000Z', 'user'],
      ['snooze', '2026-11-21T09:00:00.000Z', null, 'user'],
      ['undo', null, '2026-11-21T09:00:00.000Z', 'user'],
    ]);
    expect(events()[0]!.meta).toEqual({ actionId: a.actionId });
    expect(events()[3]!.meta).toMatchObject({ actionId: b.actionId, original: 'snooze' });
  });

  it('a snooze that changes nothing writes nothing', () => {
    repo.snooze(['c1'], null);
    expect(count()).toBe(0);
  });

  it('the waker records an auto unsnooze for inbox items only', () => {
    repo.upsertThread(thread('c2'));
    repo.snooze(['c1', 'c2'], '2026-11-08T13:00:00.000Z');
    repo.triage(['c2'], 'done');
    const before = count();
    advance(2 * HOUR);
    repo.wakeSnoozed();
    expect(events().slice(before)).toEqual([
      {
        itemId: 'c1',
        kind: 'snooze',
        from: '2026-11-08T13:00:00.000Z',
        to: null,
        source: 'auto',
        meta: { reason: 'wake' },
      },
    ]);
  });
});

describe('reply events', () => {
  const posted = () =>
    cmt('t1.mine', {
      parentId: 't1',
      authorChannelId: OWN,
      publishedAt: new Date(nowMs).toISOString(),
      textHtml: 'hi',
    });
  beforeEach(() => {
    repo.updateSettings({ ownChannelIds: [OWN] });
    repo.upsertThread(thread('t1', [{ id: 't1.r1', publishedAt: new Date(nowMs - HOUR / 2).toISOString() }]));
  });

  it('a reply sent through the app records the reply, the replied state and the auto-clear of older comments', () => {
    const post = repo.beginReplyPost('t1', 'hash');
    const r = repo.recordPostedReply({
      commentId: 't1',
      body: 'hi',
      posted: posted(),
      viaChannelId: OWN,
      replyPostId: post,
    });
    expect(events('t1')).toEqual([
      // threadSize is the thread as he saw it when he answered: one reply, not counting his own.
      {
        itemId: 't1',
        kind: 'state',
        from: 'inbox',
        to: 'replied',
        source: 'user',
        meta: { actionId: r.actionId, threadSize: 1 },
      },
      {
        itemId: 't1',
        kind: 'reply',
        from: null,
        to: null,
        source: 'user',
        meta: {
          replyPostId: post,
          postedCommentId: 't1.mine',
          viaChannelId: OWN,
          actionId: r.actionId,
          threadSize: 1,
        },
      },
    ]);
    expect(events('t1.r1')).toEqual([
      {
        itemId: 't1.r1',
        kind: 'state',
        from: 'inbox',
        to: 'auto_replied',
        source: 'auto',
        meta: { reason: 'own_reply', threadId: 't1' },
      },
    ]);
    expect(events('t1.mine')).toEqual([]); // my own comment arriving is not a decision
  });

  it('writes no event when the reply transaction fails (events are atomic with the change)', () => {
    const post = repo.beginReplyPost('t1', 'hash');
    expect(() =>
      repo.recordPostedReply({
        commentId: 't1',
        body: 'hi',
        posted: { ...posted(), publishedAt: undefined as unknown as string },
        viaChannelId: OWN,
        replyPostId: post,
      }),
    ).toThrow();
    expect(repo.getComment('t1')!.state).toBe('inbox');
    expect(count()).toBe(0);
  });

  it('changing the own channel ids records sync moves, and auto for re-run auto-clear', () => {
    repo.upsertThread(thread('t2', [{ id: 't2.mine', authorChannelId: 'UCnew' }]));
    expect(count()).toBe(0);
    repo.updateSettings({ ownChannelIds: [OWN, 'UCnew'] });
    expect(events('t2.mine')).toEqual([
      {
        itemId: 't2.mine',
        kind: 'state',
        from: 'inbox',
        to: 'own',
        source: 'sync',
        meta: { reason: 'ownership_changed' },
      },
    ]);
    // t2's top comment was published at the same instant as the reply's default; nothing else moves unless older.
    repo.updateSettings({ ownChannelIds: [OWN] });
    expect(events('t2.mine').at(-1)).toMatchObject({ from: 'own', to: 'inbox', source: 'sync' });
  });
});

describe('thread size at the moment he acted (threadSize)', () => {
  const metaOf = (itemId: string, kind: string) => events(itemId).find((e) => e.kind === kind)?.meta ?? null;

  it('a YouTube reply in a thread carries the thread reply count; so does its top comment', () => {
    repo.upsertThread(thread('t2', [{ id: 't2.r1' }, { id: 't2.r2' }, { id: 't2.r3' }]));
    repo.triage(['t2.r2'], 'done');
    repo.triage(['t2'], 'replied');
    expect(metaOf('t2.r2', 'state')).toMatchObject({ threadSize: 3 });
    expect(metaOf('t2', 'state')).toMatchObject({ threadSize: 3 });
  });

  it('records the size then, not now: a thread that grows later leaves the old event alone', () => {
    repo.upsertThread(thread('t3', [{ id: 't3.r1' }]));
    repo.triage(['t3'], 'done');
    repo.upsertThread(thread('t3', [{ id: 't3.r1' }, { id: 't3.r2' }, { id: 't3.r3' }]));
    repo.triage(['t3'], 'inbox');
    const states = events('t3').filter((e) => e.kind === 'state');
    expect(states.map((e) => e.meta?.threadSize)).toEqual([1, 3]);
  });

  it('a GitHub item carries its comment count; snooze, sync and auto events do not get one', () => {
    const feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' }).id;
    const gid = githubItemId('org', 'app', 7);
    repo.upsertGithubItems(feedId, [
      {
        id: gid,
        kind: 'issue',
        repo: 'org/app',
        number: 7,
        title: 'Seven',
        author: 'carol',
        authorAvatarUrl: null,
        authorType: 'User',
        association: 'NONE',
        bodyPlain: 'b',
        url: 'https://github.com/org/app/issues/7',
        createdAt: new Date(nowMs - HOUR).toISOString(),
        updatedAt: new Date(nowMs - HOUR).toISOString(),
        sourceState: 'open',
        draft: false,
        comments: 12,
        labels: [],
      },
    ]);
    repo.snooze([gid], new Date(nowMs + HOUR).toISOString());
    expect(metaOf(gid, 'snooze')).not.toHaveProperty('threadSize');
    repo.triage([gid], 'done');
    expect(metaOf(gid, 'state')).toMatchObject({ threadSize: 12 });
    const ev = createEvents(db);
    ev.record({
      itemId: gid,
      at: new Date(nowMs).toISOString(),
      kind: 'state',
      from: 'done',
      to: 'inbox',
      source: 'sync',
    });
    expect(
      events(gid)
        .filter((e) => e.source !== 'user')
        .every((e) => !e.meta || !('threadSize' in e.meta)),
    ).toBe(true);
  });

  it('a todo, an unknown item, and an item with unreadable data get no size; a caller-given size is kept', () => {
    const ev = createEvents(db);
    const at = new Date(nowMs).toISOString();
    db.prepare(
      `INSERT INTO items (id, provider, kind, occurred_at, state, state_source, state_changed_at, first_seen_at, data)
       VALUES ('todo:1', 'todo', 'todo', ?, 'inbox', 'user', ?, ?, NULL),
              ('gh:bad', 'github', 'pr', ?, 'inbox', 'sync', ?, ?, 'not json')`,
    ).run(at, at, at, at, at, at);
    ev.record({ itemId: 'todo:1', at, kind: 'state', from: 'inbox', to: 'done', source: 'user' });
    ev.record({ itemId: 'gh:bad', at, kind: 'state', from: 'inbox', to: 'done', source: 'user' });
    ev.record({ itemId: 'nope', at, kind: 'reply', source: 'user' });
    ev.record({ itemId: 'gh:bad', at, kind: 'reply', source: 'user', meta: { threadSize: 4 } });
    expect(metaOf('todo:1', 'state')).toBeNull();
    expect(metaOf('gh:bad', 'state')).toBeNull();
    expect(metaOf('nope', 'reply')).toBeNull();
    expect(metaOf('gh:bad', 'reply')).toEqual({ threadSize: 4 });
  });
});

describe('failed changes write no events', () => {
  it('a triage that throws part-way rolls its events back', () => {
    repo.upsertThread(thread('c1'));
    repo.upsertThread(thread('c2'));
    // Make the second UPDATE fail by violating the state CHECK.
    expect(() => repo.triage(['c1', 'c2'], 'bogus' as never)).toThrow();
    expect(count()).toBe(0);
    expect(repo.getComment('c1')!.state).toBe('inbox');
  });
});

describe('GitHub sync events', () => {
  let feedId: number;
  const up = (n: number, over: Partial<GithubItemUpsert> = {}): GithubItemUpsert => ({
    id: githubItemId('org', 'app', n),
    kind: 'pr',
    repo: 'org/app',
    number: n,
    title: `Change ${n}`,
    author: 'carol',
    authorAvatarUrl: null,
    authorType: 'User',
    association: 'CONTRIBUTOR',
    bodyPlain: `Body of ${n}`,
    url: `https://github.com/org/app/pull/${n}`,
    createdAt: new Date(nowMs + HOUR).toISOString(),
    updatedAt: new Date(nowMs + HOUR).toISOString(),
    sourceState: 'open',
    draft: false,
    comments: 0,
    labels: [],
    ...over,
  });
  const id1 = githubItemId('org', 'app', 1);

  beforeEach(() => {
    repo = createRepo(db, clock);
    feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' }).id;
  });

  it('new items, including already-closed and muted ones, write nothing', () => {
    repo.addMuteRule('author', 'spammer');
    const before = count();
    repo.upsertGithubItems(feedId, [
      up(1),
      up(2, { sourceState: 'closed' }),
      up(3, { author: 'spammer' }),
      up(4, { createdAt: '2000-01-01T00:00:00.000Z' }),
    ]);
    expect(count()).toBe(before);
  });

  it('closing upstream, reopening and new activity are sync events', () => {
    repo.upsertGithubItems(feedId, [up(1)]);
    repo.upsertGithubItems(feedId, [up(1, { sourceState: 'closed' })]);
    repo.upsertGithubItems(feedId, [up(1, { sourceState: 'open' })]);
    repo.triage([id1], 'done');
    advance(HOUR);
    repo.upsertGithubItems(feedId, [up(1, { comments: 2, lastCommenter: 'dave', lastCommenterIsMe: false })]);
    expect(events(id1).map((e) => [e.kind, e.from, e.to, e.source, e.meta?.reason])).toEqual([
      ['state', 'inbox', 'resolved', 'sync', 'closed_upstream'],
      ['state', 'resolved', 'inbox', 'sync', 'reopened'],
      ['state', 'inbox', 'done', 'user', 'done'],
      ['state', 'done', 'inbox', 'sync', 'new_activity'],
    ]);
  });

  it('a snoozed item closed upstream also records losing its snooze', () => {
    repo.upsertGithubItems(feedId, [up(1)]);
    repo.snooze([id1], '2026-12-01T00:00:00.000Z');
    repo.upsertGithubItems(feedId, [up(1, { sourceState: 'closed' })]);
    expect(
      events(id1)
        .slice(1)
        .map((e) => [e.kind, e.from, e.to, e.source]),
    ).toEqual([
      ['state', 'inbox', 'resolved', 'sync'],
      ['snooze', '2026-12-01T00:00:00.000Z', null, 'sync'],
    ]);
  });

  it('seeing my own comment appear is a sync reply event, once', () => {
    repo.upsertGithubItems(feedId, [up(1)]);
    repo.upsertGithubItems(feedId, [up(1, { comments: 1, lastCommenter: 'me', lastCommenterIsMe: true })]);
    repo.upsertGithubItems(feedId, [up(1, { comments: 1 })]);
    expect(events(id1).filter((e) => e.kind === 'reply')).toEqual([
      { itemId: id1, kind: 'reply', from: null, to: null, source: 'sync', meta: { commenter: 'me' } },
    ]);
  });

  it('changing my accounts moves items in and out of own as sync events', () => {
    repo.upsertGithubItems(feedId, [up(1, { author: 'carol' })]);
    // updateSettings recomputes GitHub ownership itself when the accounts change.
    repo.updateSettings({ github: { token: null, myAccounts: ['carol'] } });
    repo.updateSettings({ github: { token: null, myAccounts: [] } });
    expect(events(id1).map((e) => [e.from, e.to, e.source])).toEqual([
      ['inbox', 'own', 'sync'],
      ['own', 'inbox', 'sync'],
    ]);
  });
});

describe('mute events', () => {
  let feedId: number;
  beforeEach(() => {
    feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' }).id;
  });

  it('a repo rule is one event with an empty item id and the rule in meta; re-adding it is not recorded', () => {
    const { rule } = repo.addMuteRule('repo', 'org/noisy');
    repo.addMuteRule('repo', 'org/noisy');
    repo.deleteMuteRule(rule.id);
    repo.deleteMuteRule(rule.id);
    expect(events()).toEqual([
      {
        itemId: '',
        kind: 'mute',
        from: null,
        to: null,
        source: 'user',
        meta: { ruleId: rule.id, ruleKind: 'repo', value: 'org/noisy', affected: 0 },
      },
      {
        itemId: '',
        kind: 'unmute',
        from: null,
        to: null,
        source: 'user',
        meta: { ruleId: rule.id, ruleKind: 'repo', value: 'org/noisy' },
      },
    ]);
  });

  it('an item rule is recorded against the item', () => {
    const id = githubItemId('org', 'app', 7);
    repo.upsertGithubItems(feedId, [
      {
        id,
        kind: 'issue',
        repo: 'org/app',
        number: 7,
        title: 't',
        author: 'a',
        authorAvatarUrl: null,
        authorType: 'User',
        association: null,
        bodyPlain: '',
        url: 'u',
        createdAt: new Date(nowMs + HOUR).toISOString(),
        updatedAt: new Date(nowMs + HOUR).toISOString(),
        sourceState: 'open',
        draft: false,
        comments: 0,
        labels: [],
      },
    ]);
    const { affectedIds } = repo.addMuteRule('item', id);
    expect(affectedIds).toEqual([id]);
    expect(events(id)).toMatchObject([{ kind: 'mute', meta: { ruleKind: 'item', value: id, affected: 1 } }]);
  });
});

describe('export', () => {
  it('dumps events as JSONL, oldest first, optionally from a time', () => {
    repo.upsertThread(thread('c1'));
    repo.triage(['c1'], 'done');
    advance(2 * HOUR);
    repo.triage(['c1'], 'inbox');
    const lines: string[] = [];
    expect(exportEventsJsonl(db, (l) => lines.push(l))).toBe(2);
    const rows = lines.map((l) => JSON.parse(l) as ItemEventRow);
    expect(rows.map((r) => [r.kind, r.from, r.to])).toEqual([
      ['state', 'inbox', 'done'],
      ['state', 'done', 'inbox'],
    ]);
    expect(rows[0]).toMatchObject({ itemId: 'c1', source: 'user', meta: { actionId: 1 } });
    expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    const later: string[] = [];
    expect(exportEventsJsonl(db, (l) => later.push(l), { since: new Date(nowMs - HOUR).toISOString() })).toBe(1);
  });

  it('tolerates a corrupt meta column rather than aborting the dump', () => {
    db.prepare(
      "INSERT INTO item_events (item_id, at, kind, source, meta) VALUES ('x', 'a', 'state', 'user', '{bad')",
    ).run();
    const lines: string[] = [];
    exportEventsJsonl(db, (l) => lines.push(l));
    expect(JSON.parse(lines[0]!).meta).toBe('{bad');
  });
});

describe('migration 009 (item_events)', () => {
  function v8() {
    const d = new Database(':memory:');
    d.exec(MIGRATIONS.slice(0, 8).join('\n'));
    d.pragma('user_version = 8');
    const act = d.prepare(
      'INSERT INTO triage_actions (id, created_at, to_state, changes, undone_at) VALUES (?, ?, ?, ?, ?)',
    );
    act.run(
      1,
      '2026-01-01T10:00:00.000Z',
      'done',
      JSON.stringify([
        { commentId: 'a', from: 'inbox', fromSource: 'sync' },
        { commentId: 'b', from: 'inbox', fromSource: 'sync' },
      ]),
      null,
    );
    act.run(
      2,
      '2026-01-01T11:00:00.000Z',
      'archived',
      JSON.stringify([{ commentId: 'c', from: 'inbox', fromSource: 'sync' }]),
      '2026-01-01T11:05:00.000Z',
    );
    act.run(
      3,
      '2026-01-01T12:00:00.000Z',
      'snoozed',
      JSON.stringify([
        { commentId: 'a', from: null, fromWoke: null, to: '2026-01-02T09:00:00.000Z' },
        { commentId: 'd', from: '2026-01-03T00:00:00.000Z', fromWoke: null, to: null },
      ]),
      '2026-01-01T12:30:00.000Z',
    );
    act.run(4, '2026-01-01T13:00:00.000Z', 'done', '{not json', null);
    act.run(5, '2026-01-01T14:00:00.000Z', 'done', '{"commentId":"obj-not-array"}', '2026-01-01T14:01:00.000Z');
    act.run(
      6,
      '2026-01-01T15:00:00.000Z',
      'done',
      JSON.stringify(['str', 5, null, { from: 'inbox' }, { commentId: 7 }]),
      null,
    );
    act.run(7, '2026-01-01T16:00:00.000Z', 'done', 'null', null);
    return d;
  }
  const rows = (d: Database.Database) =>
    (
      d
        .prepare('SELECT item_id, at, kind, from_value, to_value, source, meta FROM item_events ORDER BY id')
        .all() as Record<string, any>[]
    ) // eslint-disable-line @typescript-eslint/no-explicit-any
      .map((r) => ({ ...r, meta: JSON.parse(r.meta) }));

  it('upgrades to 9, backfills user state, snooze and undo events, and skips malformed rows', () => {
    const d = v8();
    migrate(d);
    expect(d.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(rows(d)).toEqual([
      {
        item_id: 'a',
        at: '2026-01-01T10:00:00.000Z',
        kind: 'state',
        from_value: 'inbox',
        to_value: 'done',
        source: 'user',
        meta: { backfilled: true, actionId: 1 },
      },
      {
        item_id: 'b',
        at: '2026-01-01T10:00:00.000Z',
        kind: 'state',
        from_value: 'inbox',
        to_value: 'done',
        source: 'user',
        meta: { backfilled: true, actionId: 1 },
      },
      {
        item_id: 'c',
        at: '2026-01-01T11:00:00.000Z',
        kind: 'state',
        from_value: 'inbox',
        to_value: 'archived',
        source: 'user',
        meta: { backfilled: true, actionId: 2 },
      },
      {
        item_id: 'c',
        at: '2026-01-01T11:05:00.000Z',
        kind: 'undo',
        from_value: 'archived',
        to_value: 'inbox',
        source: 'user',
        meta: { backfilled: true, actionId: 2, original: 'state', approximate: true },
      },
      {
        item_id: 'a',
        at: '2026-01-01T12:00:00.000Z',
        kind: 'snooze',
        from_value: null,
        to_value: '2026-01-02T09:00:00.000Z',
        source: 'user',
        meta: { backfilled: true, actionId: 3 },
      },
      {
        item_id: 'd',
        at: '2026-01-01T12:00:00.000Z',
        kind: 'snooze',
        from_value: '2026-01-03T00:00:00.000Z',
        to_value: null,
        source: 'user',
        meta: { backfilled: true, actionId: 3 },
      },
      {
        item_id: 'a',
        at: '2026-01-01T12:30:00.000Z',
        kind: 'undo',
        from_value: '2026-01-02T09:00:00.000Z',
        to_value: null,
        source: 'user',
        meta: { backfilled: true, actionId: 3, original: 'snooze', approximate: true },
      },
      {
        item_id: 'd',
        at: '2026-01-01T12:30:00.000Z',
        kind: 'undo',
        from_value: null,
        to_value: '2026-01-03T00:00:00.000Z',
        source: 'user',
        meta: { backfilled: true, actionId: 3, original: 'snooze', approximate: true },
      },
    ]);
  });

  it('is additive: existing tables and rows are untouched, and re-running changes nothing', () => {
    const d = v8();
    const tables = () =>
      d
        .prepare(
          // Later migrations add tables (usage_daily, suggestions, notes), drop the label tables, and add two items columns (snooze_why, done_reason), and rebuild
          // mute_rules to allow the 'owner' kind (its rows are checked in migrations.test.ts).
          // Migration 016 adds four more (snooze_bucket, snooze_until_activity, snoozed_at, snooze_wake_cause), and 017
          // the llm_spend table.
          "SELECT name, replace(replace(replace(replace(replace(replace(sql, ', snooze_why TEXT', ''), ', done_reason TEXT CHECK (done_reason IS NULL OR done_reason IN (''no_action''))', ''), ', snooze_bucket TEXT CHECK (snooze_bucket IS NULL OR snooze_bucket IN (''waiting_on_them'',''waiting_on_merge'',''in_flight'',''lower_priority''))', ''), ', snooze_until_activity INTEGER NOT NULL DEFAULT 0', ''), ', snoozed_at TEXT', ''), ', snooze_wake_cause TEXT CHECK (snooze_wake_cause IS NULL OR snooze_wake_cause IN (''activity'',''fallback'',''manual''))', '') AS sql FROM sqlite_master WHERE name != 'item_events' AND name != 'mute_rules' AND name NOT LIKE 'idx_item_events%' AND name NOT LIKE '%usage_daily%' AND name NOT LIKE '%suggestions%' AND name NOT LIKE '%notes%' AND name NOT LIKE '%labels%' AND name NOT LIKE '%llm_spend%' ORDER BY name",
        )
        .all();
    const before = tables();
    const actions = d.prepare('SELECT * FROM triage_actions ORDER BY id').all();
    migrate(d);
    expect(tables()).toEqual(before);
    expect(d.prepare('SELECT * FROM triage_actions ORDER BY id').all()).toEqual(actions);
    const first = rows(d);
    migrate(d);
    expect(rows(d)).toEqual(first);
    expect(d.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(d.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('has the indexes and no foreign keys', () => {
    const d = v8();
    migrate(d);
    expect(
      d
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'item_events' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'idx_item_events_at' }, { name: 'idx_item_events_item' }]);
    expect(d.pragma('foreign_key_list(item_events)')).toEqual([]);
  });

  it('migrates an empty v8 database and a fresh one identically', () => {
    const d = new Database(':memory:');
    d.exec(MIGRATIONS.slice(0, 8).join('\n'));
    d.pragma('user_version = 8');
    migrate(d);
    expect(d.prepare('SELECT COUNT(*) AS n FROM item_events').get()).toEqual({ n: 0 });
  });
});

describe('mergeSnoozeMeta', () => {
  const id1 = githubItemId('org', 'app', 1);
  beforeEach(() => {
    repo = createRepo(db, clock);
    const feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'none' }).id;
    repo.upsertGithubItems(feedId, [
      {
        id: id1,
        kind: 'pr',
        repo: 'org/app',
        number: 1,
        title: 'Change',
        author: 'carol',
        authorAvatarUrl: null,
        authorType: 'User',
        association: 'CONTRIBUTOR',
        bodyPlain: '',
        url: 'https://github.com/org/app/pull/1',
        createdAt: new Date(nowMs + HOUR).toISOString(),
        updatedAt: new Date(nowMs + HOUR).toISOString(),
        sourceState: 'open',
        draft: true,
        comments: 3,
        labels: [],
      },
    ]);
  });

  it('merges into the snooze event of that action and keeps its other fields', () => {
    const a = repo.snooze([id1], '2026-12-01T00:00:00.000Z');
    const before = events(id1)[0]!;
    expect(repo.mergeSnoozeMeta(id1, a.actionId!, { lastCommenter: 'dave', comments: 3 })).toBe(true);
    const after = events(id1)[0]!;
    expect(after.meta).toEqual({ actionId: a.actionId, lastCommenter: 'dave', comments: 3 });
    expect([after.kind, after.from, after.to, after.source]).toEqual([
      before.kind,
      before.from,
      before.to,
      before.source,
    ]);
    expect(events(id1)).toHaveLength(1);
  });

  it('only touches the matching action and reports a miss', () => {
    const a = repo.snooze([id1], '2026-12-01T00:00:00.000Z');
    const b = repo.snooze([id1], '2026-12-02T00:00:00.000Z');
    expect(repo.mergeSnoozeMeta(id1, b.actionId!, { x: 1 })).toBe(true);
    expect(events(id1).map((e) => e.meta)).toEqual([{ actionId: a.actionId }, { actionId: b.actionId, x: 1 }]);
    expect(repo.mergeSnoozeMeta(id1, 9999, { x: 1 })).toBe(false);
    expect(repo.mergeSnoozeMeta('nope', a.actionId!, { x: 1 })).toBe(false);
  });

  it('reads GitHub snooze context and skips other providers', () => {
    expect(repo.githubSnoozeContext([id1, 'c-whatever'])).toEqual([
      { id: id1, kind: 'pr', repo: 'org/app', number: 1, comments: 3, createdAt: expect.any(String), draft: true },
    ]);
  });
});
