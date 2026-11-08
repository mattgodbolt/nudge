import { describe, expect, it, beforeEach } from 'vitest';
import type { GoogleAccountRow, Repo, YtComment, YtThread } from '../contracts.js';
import { createRepo, UndoError } from './repo.js';
import { openDb, migrate } from './db.js';
import { MIGRATIONS } from './migrations.js';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWN = 'UCown';
const T0 = new Date('2025-06-01T12:00:00.000Z');

let nowMs = T0.getTime();
const clock = () => new Date(nowMs);
const advance = (ms: number) => {
  nowMs += ms;
};
const hours = (h: number) => h * 3_600_000;
const at = (offsetHours: number) => new Date(T0.getTime() + hours(offsetHours)).toISOString();

function cmt(id: string, o: Partial<YtComment> = {}): YtComment {
  return {
    id,
    parentId: null,
    videoId: 'vid1',
    authorName: `Author ${id}`,
    authorChannelId: `UCa_${id}`,
    authorAvatarUrl: null,
    textHtml: `text of ${id}`,
    likeCount: 0,
    publishedAt: at(-1),
    updatedAt: at(-1),
    ...o,
  };
}
function thread(
  id: string,
  top: Partial<YtComment> = {},
  replies: Partial<YtComment>[] = [],
  o: Partial<YtThread> = {},
): YtThread {
  const topComment = cmt(id, { ...top });
  return {
    id,
    videoId: topComment.videoId,
    channelId: 'UCchan',
    canReply: true,
    topComment,
    totalReplyCount: replies.length,
    replies: replies.map((r) => cmt(r.id!, { parentId: id, videoId: topComment.videoId, ...r })),
    ...o,
  };
}

let repo: Repo;
let sourceId: number;

function setup(importMode: 'none' | 'recent' | 'all' = 'all', videos = ['vid1']) {
  const s = repo.addSource({ kind: 'playlist', ytId: 'PLx', title: 'P', thumbnailUrl: null, isOwn: false, importMode });
  repo.setSourceVideos(
    s.id,
    videos.map((id, i) => ({ id, position: i })),
  );
  return s.id;
}

beforeEach(() => {
  nowMs = T0.getTime();
  repo = createRepo(openDb(':memory:'), clock);
  sourceId = setup();
});

describe('db', () => {
  it('applies migrations once and sets user_version', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    migrate(db); // idempotent
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
  it('creates parent dirs for file databases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yt-db-'));
    const path = join(dir, 'nested', 'x.db');
    const db = openDb(path);
    expect(existsSync(path)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
    // Creating a file database is dominated by disk sync time, which varies from 5s to 40s on the ZFS deploy box.
  }, 120_000);
});

describe('settings', () => {
  it('returns defaults and persists updates', () => {
    expect(repo.getSettings()).toEqual({
      apiKey: null,
      googleClient: null,
      ownChannelIds: [],
      pollEnabled: true,
      dailyQuotaBudget: 9000,
      manualReserve: 1000,
      backfillDays: 14,
      theme: 'system',
    });
    const s = repo.updateSettings({ apiKey: 'k', theme: 'dark', pollEnabled: false });
    expect(s).toMatchObject({ apiKey: 'k', theme: 'dark', pollEnabled: false, dailyQuotaBudget: 9000 });
    expect(repo.updateSettings({ apiKey: null }).apiKey).toBeNull();
  });

  it('stores the Google client as JSON and clears it with null', () => {
    const c = { clientId: 'x.apps.googleusercontent.com', clientSecret: 's' };
    expect(repo.updateSettings({ googleClient: c }).googleClient).toEqual(c);
    expect(repo.getSettings().googleClient).toEqual(c);
    expect(repo.updateSettings({ googleClient: null }).googleClient).toBeNull();
  });
});

describe('upsertThread', () => {
  it('is idempotent', () => {
    const t = thread('t1', {}, [{ id: 't1.r1' }]);
    const first = repo.upsertThread(t);
    expect(first.newCommentIds.sort()).toEqual(['t1', 't1.r1']);
    const second = repo.upsertThread(t);
    expect(second.newCommentIds).toEqual([]);
    expect(second.changedIds).toEqual([]);
    expect(repo.counts().inbox).toBe(2);
    expect(repo.getThreadState('t1')).toMatchObject({ totalReplyCount: 1, fetchedReplyCount: 1 });
  });
  it('reports edited comments as changed without changing their state', () => {
    repo.upsertThread(thread('t1'));
    repo.triage(['t1'], 'done');
    const r = repo.upsertThread(thread('t1', { textHtml: 'edited &amp; new', likeCount: 5 }));
    expect(r.changedIds).toEqual(['t1']);
    const c = repo.getComment('t1')!;
    expect(c.state).toBe('done');
    expect(c.textPlain).toBe('edited & new');
    expect(c.likeCount).toBe(5);
    expect(c.permalink).toBe('https://www.youtube.com/watch?v=vid1&lc=t1');
  });
  it('tracks total vs fetched replies and addReplies completes them', () => {
    repo.upsertThread(thread('t1', {}, [{ id: 'r1' }], { totalReplyCount: 3 }));
    expect(repo.getThreadState('t1')).toMatchObject({ totalReplyCount: 3, fetchedReplyCount: 1 });
    const res = repo.addReplies('t1', [cmt('r1', { parentId: 't1' }), cmt('r2'), cmt('r3')]);
    expect(res.newCommentIds).toEqual(['r2', 'r3']);
    expect(repo.getThreadState('t1')).toMatchObject({ totalReplyCount: 3, fetchedReplyCount: 3 });
    expect(repo.getComment('r2')!.parentId).toBe('t1');
    expect(repo.getThreadState('nope')).toBeNull();
    expect(() => repo.addReplies('nope', [])).toThrow();
  });
  it('creates a stub video when unknown', () => {
    repo.upsertThread(thread('tx', { videoId: 'other' }));
    expect(repo.getVideoSyncRow('other')).not.toBeNull();
  });
});

describe('baseline and archived', () => {
  it('archives comments published before the baseline', () => {
    repo = createRepo(openDb(':memory:'), clock);
    const id = setup('recent', ['vid1']); // baseline = now - 14d
    expect(id).toBe(1);
    const base = repo.getVideoSyncRow('vid1')!.baselineAt!;
    expect(new Date(base).getTime()).toBe(T0.getTime() - 14 * 86_400_000);
    repo.upsertThread(thread('old', { publishedAt: at(-24 * 20) }, [{ id: 'old.r', publishedAt: at(-24 * 20 + 1) }]));
    repo.upsertThread(thread('new', { publishedAt: at(-24 * 2) }));
    expect(repo.getComment('old')!.state).toBe('archived');
    expect(repo.getComment('old.r')!.state).toBe('archived');
    expect(repo.getComment('new')!.state).toBe('inbox');
    expect(repo.counts()).toMatchObject({ inbox: 1, all: 3, done: 0 });
  });
  it('import mode none uses add time, all uses epoch', () => {
    repo = createRepo(openDb(':memory:'), clock);
    setup('none', ['vn']);
    expect(repo.getVideoSyncRow('vn')!.baselineAt).toBe(T0.toISOString());
    repo.upsertThread(thread('a', { videoId: 'vn', publishedAt: at(-1) }));
    expect(repo.getComment('a')!.state).toBe('archived');
    const s2 = repo.addSource({
      kind: 'video',
      ytId: 'va',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.setSourceVideos(s2.id, [{ id: 'va', position: 0 }]);
    expect(repo.getVideoSyncRow('va')!.baselineAt).toBe('1970-01-01T00:00:00.000Z');
    repo.upsertThread(thread('b', { videoId: 'va', publishedAt: '2001-01-01T00:00:00Z' }));
    expect(repo.getComment('b')!.state).toBe('inbox');
  });
  it('honours backfillDays and does not overwrite an existing baseline', () => {
    repo = createRepo(openDb(':memory:'), clock);
    repo.updateSettings({ backfillDays: 2 });
    setup('recent', ['v']);
    expect(repo.getVideoSyncRow('v')!.baselineAt).toBe(at(-48));
    const s2 = repo.addSource({
      kind: 'video',
      ytId: 'v',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    expect(repo.setSourceVideos(s2.id, [{ id: 'v', position: 0 }]).added).toEqual(['v']);
    expect(repo.getVideoSyncRow('v')!.baselineAt).toBe(at(-48));
  });
  it('setSourceVideos reports only newly attached videos', () => {
    expect(
      repo.setSourceVideos(sourceId, [
        { id: 'vid1', position: 0 },
        { id: 'vid2', position: 1 },
      ]).added,
    ).toEqual(['vid2']);
  });
});

describe('own channel', () => {
  beforeEach(() => {
    repo.updateSettings({ ownChannelIds: [OWN] });
  });
  it('marks own authors as own and never counts them', () => {
    repo.upsertThread(thread('t1', { authorChannelId: OWN }));
    const c = repo.getComment('t1')!;
    expect(c).toMatchObject({ state: 'own', isOwn: true, stateSource: 'sync' });
    expect(repo.counts()).toMatchObject({ inbox: 0, all: 0, done: 0 });
    expect(repo.listInbox({ view: 'all' }).items).toHaveLength(0);
  });
  it('auto-clears only earlier inbox comments in the same thread', () => {
    repo.upsertThread(
      thread('t1', { publishedAt: at(-5) }, [
        { id: 'r1', publishedAt: at(-4) },
        { id: 'r3', publishedAt: at(-1) },
      ]),
    );
    repo.upsertThread(thread('t2', { publishedAt: at(-5) }));
    repo.triage(['r1'], 'done');
    // own reply at -2 : clears t1 (earlier, inbox) but not r3 (later) nor r1 (user-set done) nor t2 (other thread)
    const res = repo.addReplies('t1', [cmt('own1', { parentId: 't1', authorChannelId: OWN, publishedAt: at(-2) })]);
    expect(res.changedIds).toEqual(['t1']);
    expect(repo.getComment('t1')).toMatchObject({ state: 'auto_replied', stateSource: 'auto' });
    expect(repo.getComment('r1')!.state).toBe('done');
    expect(repo.getComment('r3')!.state).toBe('inbox');
    expect(repo.getComment('t2')!.state).toBe('inbox');
    expect(repo.getComment('own1')!.state).toBe('own');
    expect(repo.counts()).toMatchObject({ inbox: 2, done: 2 });
  });
  it('does not auto-clear comments the user explicitly returned to inbox', () => {
    repo.upsertThread(thread('t1', { publishedAt: at(-5) }));
    repo.triage(['t1'], 'done');
    repo.triage(['t1'], 'inbox');
    repo.addReplies('t1', [cmt('own1', { parentId: 't1', authorChannelId: OWN, publishedAt: at(-2) })]);
    expect(repo.getComment('t1')!.state).toBe('inbox');
  });
  it('auto-clears on initial upsert when the own reply is inline', () => {
    repo.upsertThread(
      thread('t1', { publishedAt: at(-5) }, [{ id: 'own1', authorChannelId: OWN, publishedAt: at(-3) }]),
    );
    expect(repo.getComment('t1')!.state).toBe('auto_replied');
  });
  it('recomputeOwnership moves sync/auto rows both ways but never user rows', () => {
    repo.updateSettings({ ownChannelIds: [] });
    repo.upsertThread(
      thread('t1', { publishedAt: at(-5), authorChannelId: 'UCother' }, [
        { id: 'mine', authorChannelId: OWN, publishedAt: at(-3) },
        { id: 'late', publishedAt: at(-1) },
      ]),
    );
    repo.upsertThread(thread('t2', { publishedAt: at(-5), authorChannelId: 'UCx' }));
    repo.triage(['t2'], 'done');
    expect(repo.getComment('mine')!.state).toBe('inbox');
    expect(repo.counts().inbox).toBe(3);

    repo.updateSettings({ ownChannelIds: [OWN] });
    expect(repo.getComment('mine')).toMatchObject({ state: 'own', isOwn: true });
    expect(repo.getComment('t1')).toMatchObject({ state: 'auto_replied', stateSource: 'auto' });
    expect(repo.getComment('late')!.state).toBe('inbox');
    expect(repo.getComment('t2')!.state).toBe('done');

    // remove ownership again: everything reverts
    repo.updateSettings({ ownChannelIds: [] });
    expect(repo.getComment('mine')).toMatchObject({ state: 'inbox', isOwn: false });
    expect(repo.getComment('t1')!.state).toBe('inbox');
    expect(repo.getComment('t2')!.state).toBe('done');
  });
  it('flags video rows belonging to the own channel', () => {
    repo.updateSettings({ ownChannelIds: ['UCchan'] });
    repo.upsertVideos([
      {
        id: 'vid1',
        title: 'T',
        channelId: 'UCchan',
        channelTitle: 'C',
        thumbnailUrl: null,
        publishedAt: at(-1),
        viewCount: 1,
        commentCount: 1,
      },
    ]);
    expect(repo.getVideoSyncRow('vid1')!.isOwnChannel).toBe(true);
  });
});

describe('triage and undo', () => {
  beforeEach(() => {
    repo.upsertThread(thread('a', {}, [{ id: 'b' }, { id: 'c' }]));
  });
  it('moves comments and returns changes with counts', () => {
    const r = repo.triage(['a', 'b', 'a'], 'done');
    expect(r.changes).toEqual([
      { commentId: 'a', from: 'inbox', to: 'done' },
      { commentId: 'b', from: 'inbox', to: 'done' },
    ]);
    expect(r.counts).toMatchObject({ inbox: 1, done: 2, all: 3 });
    expect(repo.getComment('a')).toMatchObject({ state: 'done', stateSource: 'user' });
    expect(repo.triage(['a'], 'done').changes).toEqual([]);
    expect(repo.triage(['nope'], 'done').changes).toEqual([]);
  });
  it('undo restores previous states', () => {
    repo.triage(['a'], 'replied');
    const r = repo.triage(['b', 'c'], 'done');
    const u = repo.undo(r.actionId);
    expect(u.changes).toEqual([
      { commentId: 'b', from: 'done', to: 'inbox' },
      { commentId: 'c', from: 'done', to: 'inbox' },
    ]);
    expect(u.counts.inbox).toBe(2);
    expect(repo.getComment('b')).toMatchObject({ state: 'inbox', stateSource: 'sync' });
  });
  it('undo only restores where the state still equals to_state', () => {
    const r = repo.triage(['a', 'b'], 'done');
    repo.triage(['b'], 'replied');
    const u = repo.undo(r.actionId);
    expect(u.changes).toEqual([{ commentId: 'a', from: 'done', to: 'inbox' }]);
    expect(repo.getComment('a')!.state).toBe('inbox');
    expect(repo.getComment('b')!.state).toBe('replied');
  });
  it('refuses to undo twice, unknown or expired actions', () => {
    const r = repo.triage(['a'], 'done');
    repo.undo(r.actionId);
    expect(() => repo.undo(r.actionId)).toThrow(UndoError);
    expect(() => repo.undo(9999)).toThrow(/No such action/);
    const r2 = repo.triage(['b'], 'done');
    advance(hours(24));
    try {
      repo.undo(r2.actionId);
      expect.unreachable();
    } catch (e) {
      expect((e as UndoError).code).toBe('expired');
    }
    expect(repo.getComment('b')!.state).toBe('done');
  });
  it('allows undo just inside 24h', () => {
    const r = repo.triage(['a'], 'done');
    advance(hours(24) - 1);
    expect(repo.undo(r.actionId).changes).toHaveLength(1);
  });
  it('never triages own comments', () => {
    repo.updateSettings({ ownChannelIds: ['UCme'] });
    repo.upsertThread(thread('m', { authorChannelId: 'UCme' }));
    expect(repo.triage(['m'], 'done').changes).toEqual([]);
    expect(repo.getComment('m')!.state).toBe('own');
  });
});

describe('drafts and hand-off', () => {
  beforeEach(() => {
    repo.upsertThread(thread('a'));
  });
  it('put/get/delete drafts', () => {
    expect(repo.getDraft('a')).toBeNull();
    const d = repo.putDraft('a', 'hello');
    expect(d).toEqual({ body: 'hello', updatedAt: T0.toISOString(), status: 'draft' });
    expect(repo.listInbox({ view: 'inbox' }).items[0]!.hasDraft).toBe(true);
    repo.deleteDraft('a');
    expect(repo.getDraft('a')).toBeNull();
    expect(repo.listInbox({ view: 'inbox' }).items[0]!.hasDraft).toBe(false);
  });
  it('markHandedOff saves the draft, marks replied and is undoable', () => {
    repo.putDraft('a', 'draft body');
    const r = repo.markHandedOff('a', 'final body');
    expect(r.changes).toEqual([{ commentId: 'a', from: 'inbox', to: 'replied' }]);
    expect(repo.getDraft('a')).toMatchObject({ body: 'final body', status: 'handed_off' });
    expect(repo.getComment('a')!.state).toBe('replied');
    repo.undo(r.actionId);
    expect(repo.getComment('a')!.state).toBe('inbox');
    expect(() => repo.markHandedOff('missing', 'x')).toThrow();
  });
  it('drafts vanish with their comment', () => {
    repo.putDraft('a', 'x');
    repo.deleteSource(sourceId, true);
    expect(repo.getDraft('a')).toBeNull();
  });
});

describe('listInbox', () => {
  it('filters by view', () => {
    repo.updateSettings({ ownChannelIds: [OWN] });
    repo.upsertThread(
      thread('a', { publishedAt: at(-5) }, [
        { id: 'b', publishedAt: at(-4) },
        { id: 'c', publishedAt: at(-3) },
        { id: 'o', authorChannelId: OWN, publishedAt: at(-1) },
      ]),
    );
    // a,b,c auto-cleared by o. Add fresh + triaged ones.
    repo.upsertThread(thread('d', { publishedAt: at(-2) }));
    repo.upsertThread(thread('e', { publishedAt: at(-2) }));
    repo.upsertThread(thread('f', { publishedAt: at(-2) }));
    repo.triage(['d'], 'done');
    repo.triage(['e'], 'replied');
    const ids = (view: 'inbox' | 'done' | 'all') =>
      repo
        .listInbox({ view })
        .items.map((i) => i.comment.id)
        .sort();
    expect(ids('inbox')).toEqual(['f']);
    expect(ids('done')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids('all')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
  it('filters by source and video and includes parent context', () => {
    const s2 = setupSecond();
    repo.upsertThread(thread('a', { videoId: 'vid1' }, [{ id: 'a.r', textHtml: 'reply &amp; more' }]));
    repo.upsertThread(thread('z', { videoId: 'vid2' }));
    expect(repo.listInbox({ view: 'inbox', sourceId: s2 }).items.map((i) => i.comment.id)).toEqual(['z']);
    expect(repo.listInbox({ view: 'inbox', videoId: 'vid1' }).total).toBe(2);
    const reply = repo.listInbox({ view: 'inbox', videoId: 'vid1' }).items.find((i) => i.comment.id === 'a.r')!;
    expect(reply.parent).toEqual({ id: 'a', authorName: 'Author a', textPlain: 'text of a', isOwn: false });
    expect(reply.threadReplyCount).toBe(1);
    expect(reply.comment.textPlain).toBe('reply & more');
    const top = repo.listInbox({ view: 'inbox', videoId: 'vid1' }).items.find((i) => i.comment.id === 'a')!;
    expect(top.parent).toBeNull();
    expect(top.video).toEqual({ id: 'vid1', title: '', thumbnailUrl: null });
  });
  function setupSecond() {
    const s = repo.addSource({
      kind: 'video',
      ytId: 'vid2',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.setSourceVideos(s.id, [{ id: 'vid2', position: 0 }]);
    return s.id;
  }

  it('paginates stably, including ties on published_at, and survives inserts/triage between pages', () => {
    const same = at(-3);
    for (let i = 0; i < 7; i++) repo.upsertThread(thread(`t${i}`, { publishedAt: i < 5 ? same : at(-4 - i) }));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = repo.listInbox({ view: 'inbox', limit: 3, cursor });
      seen.push(...page.items.map((i) => i.comment.id));
      pages++;
      if (pages === 1) {
        // mutate between pages: a newer comment arrives and an already-seen one is triaged
        repo.upsertThread(thread('newest', { publishedAt: at(-1) }));
        repo.triage([seen[0]!], 'done');
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
    expect(pages).toBe(3);
  });
  it('returns total independent of the page and null cursor on the last page', () => {
    for (let i = 0; i < 4; i++) repo.upsertThread(thread(`t${i}`, { publishedAt: at(-i - 1) }));
    const p = repo.listInbox({ view: 'inbox', limit: 4 });
    expect(p.total).toBe(4);
    expect(p.nextCursor).toBeNull();
    expect(repo.listInbox({ view: 'inbox', limit: 2 }).nextCursor).toBe(`${at(-2)}|t1`);
  });
});

describe('search', () => {
  beforeEach(() => {
    repo.upsertThread(thread('a', { textHtml: 'Loved the <b>Café</b> tutorial!', authorName: 'Zoë Smith' }));
    repo.upsertThread(thread('b', { textHtml: 'compiler explorer is great', authorName: 'Bob' }));
    repo.upsertThread(thread('c', { textHtml: 'unrelated text', authorName: 'Carol' }));
  });
  const q = (s: string, view: 'inbox' | 'all' = 'all') => repo.listInbox({ view, q: s }).items.map((i) => i.comment.id);
  it('matches words, prefixes, diacritics and author names', () => {
    expect(q('tutorial')).toEqual(['a']);
    expect(q('compil')).toEqual(['b']);
    expect(q('cafe')).toEqual(['a']);
    expect(q('zoe')).toEqual(['a']);
    expect(q('explorer great')).toEqual(['b']);
    expect(q('nothing')).toEqual([]);
  });
  it('is safe against FTS syntax in the query', () => {
    expect(q('"unbalanced')).toEqual([]);
    expect(q('a OR b NEAR(')).toEqual([]);
    expect(q('***')).toEqual([]);
    expect(repo.listInbox({ view: 'all', q: '***' }).total).toBe(0);
  });
  it('combines with view filters and tracks edits and deletions', () => {
    repo.triage(['b'], 'done');
    expect(q('compiler', 'inbox')).toEqual([]);
    repo.upsertThread(thread('c', { textHtml: 'now about gadgets' }));
    expect(q('gadgets')).toEqual(['c']);
    expect(q('unrelated')).toEqual([]);
    repo.deleteSource(sourceId, true);
    expect(q('gadgets')).toEqual([]);
  });
  it('ignores an empty query', () => {
    expect(repo.listInbox({ view: 'all', q: '  ' }).total).toBe(3);
  });
});

describe('counts', () => {
  it('reports inbox/done/all and per-source inbox counts', () => {
    repo.updateSettings({ ownChannelIds: [OWN] });
    const s2 = repo.addSource({
      kind: 'video',
      ytId: 'vid2',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.setSourceVideos(s2.id, [{ id: 'vid2', position: 0 }]);
    const empty = repo.addSource({
      kind: 'video',
      ytId: 'vid3',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.upsertThread(
      thread('a', { publishedAt: at(-3) }, [
        { id: 'a2', publishedAt: at(-2) },
        { id: 'ao', authorChannelId: OWN, publishedAt: at(-1) },
      ]),
    );
    repo.upsertThread(thread('z', { videoId: 'vid2' }));
    repo.upsertThread(thread('y', { videoId: 'vid2' }));
    repo.triage(['y'], 'done');
    expect(repo.counts()).toEqual({
      inbox: 1,
      done: 3,
      all: 4,
      snoozed: 0,
      bySource: { [sourceId]: 0, [s2.id]: 1, [empty.id]: 0 },
      byLabel: {},
    });
    expect(repo.listSources().find((s) => s.id === s2.id)!.inboxCount).toBe(1);
  });
  it('counts a video in two sources for each', () => {
    const s2 = repo.addSource({
      kind: 'video',
      ytId: 'vid1',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.setSourceVideos(s2.id, [{ id: 'vid1', position: 0 }]);
    repo.upsertThread(thread('a'));
    expect(repo.counts().bySource).toEqual({ [sourceId]: 1, [s2.id]: 1 });
    expect(repo.counts().inbox).toBe(1);
  });
});

describe('getThread', () => {
  it('orders top-level first then replies chronologically and includes video tier', () => {
    repo.upsertVideos([
      {
        id: 'vid1',
        title: 'Vid',
        channelId: 'UCchan',
        channelTitle: 'Chan',
        thumbnailUrl: 'u',
        publishedAt: at(-2),
        viewCount: 10,
        commentCount: 3,
      },
    ]);
    repo.upsertThread(
      thread(
        'a',
        { publishedAt: at(-5) },
        [
          { id: 'r2', publishedAt: at(-3) },
          { id: 'r1', publishedAt: at(-4) },
        ],
        { canReply: false, totalReplyCount: 4 },
      ),
    );
    const t = repo.getThread('a')!;
    expect(t.comments.map((c) => c.id)).toEqual(['a', 'r1', 'r2']);
    expect(t).toMatchObject({ threadId: 'a', canReply: false, totalReplyCount: 4 });
    expect(t.video).toMatchObject({ id: 'vid1', title: 'Vid', tier: 'hot', tierOverride: null, inboxCount: 3 });
    expect(repo.getThread('nope')).toBeNull();
  });
});

describe('videos, tiers and sync scheduling', () => {
  beforeEach(() => {
    repo.upsertVideos([
      {
        id: 'vid1',
        title: 'Hot',
        channelId: 'c',
        channelTitle: 'c',
        thumbnailUrl: null,
        publishedAt: at(-24),
        viewCount: 1,
        commentCount: 1,
      },
      {
        id: 'old',
        title: 'Old',
        channelId: 'c',
        channelTitle: 'c',
        thumbnailUrl: null,
        publishedAt: at(-24 * 400),
        viewCount: 1,
        commentCount: 1,
      },
    ]);
    repo.setSourceVideos(sourceId, [
      { id: 'vid1', position: 0 },
      { id: 'old', position: 1 },
    ]);
  });
  it('derives tier and honours override', () => {
    const tiers = () => Object.fromEntries(repo.listVideos(sourceId).map((v) => [v.id, v.tier]));
    expect(tiers()).toEqual({ vid1: 'hot', old: 'frozen' });
    const v = repo.setVideoTier('old', 'paused');
    expect(v).toMatchObject({ tier: 'paused', tierOverride: 'paused' });
    expect(repo.setVideoTier('old', null).tierOverride).toBeNull();
    expect(() => repo.setVideoTier('nope', 'hot')).toThrow();
  });
  it('dueVideos honours next_sync_at, backoff, missing, paused and disabled sources', () => {
    const due = () =>
      repo
        .dueVideos(clock(), 10)
        .map((r) => r.id)
        .sort();
    expect(due()).toEqual(['old', 'vid1']); // new rows are due immediately
    repo.updateVideoSync('vid1', { nextSyncAt: at(1), lastSyncedAt: at(0) });
    expect(due()).toEqual(['old']);
    repo.updateVideoSync('old', { backoffUntil: at(2), errorCount: 2, lastError: 'boom' });
    expect(due()).toEqual([]);
    advance(hours(3));
    expect(due()).toEqual(['old', 'vid1']);
    repo.updateVideoSync('old', { missing: true });
    repo.setVideoTier('vid1', 'paused');
    expect(due()).toEqual([]);
    repo.setVideoTier('vid1', null);
    repo.updateSource(sourceId, { enabled: false });
    expect(due()).toEqual([]);
    expect(repo.allVideoRows()).toEqual([]);
    expect(repo.allVideoRows(sourceId)).toHaveLength(2);
  });
  it('limits and orders by next_sync_at', () => {
    repo.updateVideoSync('vid1', { nextSyncAt: at(-1) });
    repo.updateVideoSync('old', { nextSyncAt: at(-2) });
    expect(repo.dueVideos(clock(), 1).map((r) => r.id)).toEqual(['old']);
  });
  it('updateVideoSync round-trips fields', () => {
    repo.updateVideoSync('vid1', { commentsDisabled: true, errorCount: 3, lastDeepScanAt: at(0), baselineAt: at(-5) });
    expect(repo.getVideoSyncRow('vid1')).toMatchObject({
      commentsDisabled: true,
      errorCount: 3,
      lastDeepScanAt: at(0),
      baselineAt: at(-5),
    });
    expect(repo.listVideos().find((v) => v.id === 'vid1')!.commentsDisabled).toBe(true);
    expect(repo.getVideoSyncRow('nope')).toBeNull();
  });
});

describe('sources', () => {
  it('addSource is idempotent per (kind, ytId) and DTOs include projected units', () => {
    const a = repo.addSource({
      kind: 'playlist',
      ytId: 'PLx',
      title: 'dup',
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    expect(a.id).toBe(sourceId);
    expect(repo.listSources()).toHaveLength(1);
  });
  it('projects units per day from tiers (+ own feed polling)', () => {
    repo.upsertVideos([
      {
        id: 'vid1',
        title: '',
        channelId: null,
        channelTitle: null,
        thumbnailUrl: null,
        publishedAt: at(-24),
        viewCount: null,
        commentCount: null,
      },
      {
        id: 'w',
        title: '',
        channelId: null,
        channelTitle: null,
        thumbnailUrl: null,
        publishedAt: at(-24 * 10),
        viewCount: null,
        commentCount: null,
      },
      {
        id: 'dis',
        title: '',
        channelId: null,
        channelTitle: null,
        thumbnailUrl: null,
        publishedAt: at(-24),
        viewCount: null,
        commentCount: null,
      },
    ]);
    repo.setSourceVideos(sourceId, [
      { id: 'vid1', position: 0 },
      { id: 'w', position: 1 },
      { id: 'dis', position: 2 },
    ]);
    repo.updateVideoSync('dis', { commentsDisabled: true });
    expect(repo.listSources()[0]).toMatchObject({ videoCount: 3, projectedUnitsPerDay: 144 + 24 });
    repo.setVideoTier('vid1', 'paused');
    expect(repo.listSources()[0]!.projectedUnitsPerDay).toBe(24);
    const own = repo.addSource({
      kind: 'channel',
      ytId: 'UCown',
      title: 'Me',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'recent',
      uploadsPlaylistId: 'UUown',
    });
    expect(own.projectedUnitsPerDay).toBe(144);
    expect(repo.getSourceRow(own.id)).toMatchObject({ uploadsPlaylistId: 'UUown', enabled: true });
    expect(repo.updateSource(own.id, { enabled: false }).projectedUnitsPerDay).toBe(0);
  });
  it('updateSource patches fields', () => {
    const s = repo.updateSource(sourceId, {
      title: 'New',
      importMode: 'none',
      isOwn: true,
      lastError: 'x',
      membershipRefreshedAt: at(0),
    });
    expect(s).toMatchObject({ title: 'New', importMode: 'none', isOwn: true, lastError: 'x' });
    expect(repo.getSourceRow(sourceId)!.membershipRefreshedAt).toBe(at(0));
    expect(repo.enabledSourceRows()).toHaveLength(1);
    expect(() => repo.updateSource(999, { title: 'x' })).toThrow();
  });
  it('deleteSource keeps data without purge; purge only removes unshared videos', () => {
    const s2 = repo.addSource({
      kind: 'video',
      ytId: 'shared',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.setSourceVideos(sourceId, [{ id: 'shared', position: 1 }]);
    repo.setSourceVideos(s2.id, [{ id: 'shared', position: 0 }]);
    repo.upsertThread(thread('mine'));
    repo.upsertThread(thread('both', { videoId: 'shared' }));

    const s3 = repo.addSource({
      kind: 'video',
      ytId: 'keep',
      title: null,
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'all',
    });
    repo.setSourceVideos(s3.id, [{ id: 'keep', position: 0 }]);
    repo.upsertThread(thread('kept', { videoId: 'keep' }));
    repo.deleteSource(s3.id, false);
    expect(repo.getComment('kept')).not.toBeNull();

    repo.deleteSource(sourceId, true);
    expect(repo.getComment('mine')).toBeNull();
    expect(repo.getVideoSyncRow('vid1')).toBeNull();
    expect(repo.getComment('both')).not.toBeNull();
    expect(repo.listSources().map((s) => s.id)).toEqual([s2.id]);
  });
});

describe('quota ledger and runs', () => {
  it('accumulates quota per day and endpoint', () => {
    repo.recordQuota('2025-06-01', 'commentThreads.list', 1);
    repo.recordQuota('2025-06-01', 'commentThreads.list', 1);
    repo.recordQuota('2025-06-01', 'videos.list', 3);
    repo.recordQuota('2025-06-02', 'videos.list', 7);
    expect(repo.quotaUsed('2025-06-01')).toBe(5);
    expect(repo.quotaUsed('2025-06-02')).toBe(7);
    expect(repo.quotaUsed('2030-01-01')).toBe(0);
    expect(repo.quotaByEndpoint('2025-06-01')).toEqual([
      { endpoint: 'commentThreads.list', units: 2, calls: 2 },
      { endpoint: 'videos.list', units: 3, calls: 1 },
    ]);
  });
  it('records sync runs', () => {
    expect(repo.lastRun()).toBeNull();
    const id = repo.startRun('manual', 'all');
    expect(repo.lastRun()).toBeNull(); // only finished runs count
    advance(5000);
    const s = repo.finishRun(id, { units: 12, videos: 3, newComments: 4, error: null });
    expect(s).toEqual({
      id,
      trigger: 'manual',
      startedAt: T0.toISOString(),
      finishedAt: new Date(nowMs).toISOString(),
      units: 12,
      videos: 3,
      newComments: 4,
      error: null,
    });
    const id2 = repo.startRun('poll', 'all');
    repo.finishRun(id2, { units: 0, videos: 0, newComments: 0, error: 'quota' });
    expect(repo.lastRun()).toMatchObject({ id: id2, error: 'quota' });
  });
});

describe('google accounts', () => {
  const acct = (channelId: string, o: Partial<GoogleAccountRow> = {}): GoogleAccountRow => ({
    channelId,
    title: channelId,
    thumbnailUrl: null,
    refreshToken: 'r',
    accessToken: null,
    accessExpiresAt: null,
    scope: 'scope',
    connectedAt: at(0),
    needsReauth: false,
    lastError: null,
    isDefault: false,
    ...o,
  });

  it('round-trips and makes the first account the default', () => {
    repo.upsertGoogleAccount(acct('UC1'));
    expect(repo.listGoogleAccounts()).toEqual([acct('UC1', { isDefault: true })]);
  });

  it('keeps one default; setDefault and delete re-point it', () => {
    repo.upsertGoogleAccount(acct('UC1', { connectedAt: at(0) }));
    repo.upsertGoogleAccount(acct('UC2', { connectedAt: at(1) }));
    expect(repo.listGoogleAccounts().map((a) => a.isDefault)).toEqual([true, false]);
    repo.setDefaultGoogleAccount('UC2');
    expect(repo.listGoogleAccounts().map((a) => a.isDefault)).toEqual([false, true]);
    repo.deleteGoogleAccount('UC2');
    expect(repo.listGoogleAccounts().map((a) => [a.channelId, a.isDefault])).toEqual([['UC1', true]]);
    expect(() => repo.setDefaultGoogleAccount('nope')).toThrow();
  });

  it('reconnecting the default account keeps it default', () => {
    repo.upsertGoogleAccount(acct('UC1'));
    repo.upsertGoogleAccount(acct('UC2', { connectedAt: at(1) }));
    repo.upsertGoogleAccount(acct('UC1', { refreshToken: 'new' }));
    const a = repo.listGoogleAccounts().find((x) => x.channelId === 'UC1')!;
    expect(a).toMatchObject({ refreshToken: 'new', isDefault: true });
  });

  it('updates a subset of fields, including booleans', () => {
    repo.upsertGoogleAccount(acct('UC1'));
    repo.updateGoogleAccount('UC1', { needsReauth: true, lastError: 'invalid_grant', accessToken: 'a' });
    expect(repo.listGoogleAccounts()[0]).toMatchObject({
      needsReauth: true,
      lastError: 'invalid_grant',
      accessToken: 'a',
      refreshToken: 'r',
    });
  });
});

describe('reply posts', () => {
  beforeEach(() => {
    setup();
    repo.updateSettings({ ownChannelIds: [OWN] });
    repo.upsertThread(thread('t1', {}, [{ id: 't1.r1', publishedAt: at(-0.5) }]));
  });
  const posted = (id = 't1.mine') =>
    cmt(id, { parentId: 't1', authorChannelId: OWN, publishedAt: at(0), updatedAt: at(0), textHtml: 'hi' });

  it('records a posted reply in one step: draft, triage, own insert, auto-clear, post row', () => {
    const post = repo.beginReplyPost('t1', 'hash');
    const r = repo.recordPostedReply({
      commentId: 't1',
      body: 'hi',
      posted: posted(),
      viaChannelId: OWN,
      replyPostId: post,
    });
    expect(r.newCommentIds).toEqual(['t1.mine']);
    expect(r.changedIds).toContain('t1.r1'); // older inbox reply auto-cleared
    expect(repo.getComment('t1')).toMatchObject({ state: 'replied', stateSource: 'user' });
    expect(repo.getComment('t1.mine')).toMatchObject({ state: 'own', isOwn: true });
    expect(repo.getComment('t1.r1')!.state).toBe('auto_replied');
    expect(repo.getDraft('t1')).toMatchObject({ body: 'hi', status: 'posted' });
    expect(repo.isAppPostedReply('t1.mine')).toBe(true);
    expect(repo.isAppPostedReply('t1.r1')).toBe(false);
    // undo only touches the target; the posted reply stays
    repo.undo(r.actionId);
    expect(repo.getComment('t1')!.state).toBe('inbox');
    expect(repo.getComment('t1.mine')).not.toBeNull();
  });

  it('rolls everything back when the transaction fails', () => {
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
    expect(repo.getDraft('t1')).toBeNull();
    expect(repo.isAppPostedReply('t1.mine')).toBe(false);
  });

  it('recentPostedReply honours body hash, status and the time window', () => {
    const post = repo.beginReplyPost('t1', 'h1');
    expect(repo.recentPostedReply('t1', 'h1', at(-1))).toBeNull(); // still pending
    repo.finishReplyPost(post, { status: 'posted', postedCommentId: 't1.mine', viaChannelId: OWN });
    expect(repo.recentPostedReply('t1', 'h1', at(-1))).toEqual({ postedCommentId: 't1.mine' });
    expect(repo.recentPostedReply('t1', 'other', at(-1))).toBeNull();
    advance(hours(1));
    expect(repo.recentPostedReply('t1', 'h1', at(0.5))).toBeNull();
  });

  it('removeLocalComment drops a reply and refreshes thread stats; unknown id is a no-op', () => {
    repo.addReplies('t1', [posted()]);
    expect(repo.getThread('t1')!.comments.map((c) => c.id)).toContain('t1.mine');
    repo.removeLocalComment('t1.mine');
    expect(repo.getComment('t1.mine')).toBeNull();
    repo.removeLocalComment('nope');
  });

  it('setThreadCanReply flips the thread flag', () => {
    repo.setThreadCanReply('t1', false);
    expect(repo.getThread('t1')!.canReply).toBe(false);
  });
});

describe('stats', () => {
  const vid = (id: string, o: Partial<import('../contracts.js').YtVideo> = {}) => ({
    id,
    title: id,
    channelId: null,
    channelTitle: null,
    thumbnailUrl: null,
    publishedAt: at(-48),
    viewCount: 100,
    commentCount: 10,
    durationSeconds: 600,
    likeCount: 7,
    ...o,
  });

  it('totals duration, likes and comments once per video, even when two sources list it', () => {
    repo.upsertVideos([vid('vid1'), vid('vid2', { durationSeconds: 90, likeCount: 3, commentCount: 5 })]);
    const second = repo.addSource({
      kind: 'playlist',
      ytId: 'PLy',
      title: 'Mine',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'all',
    });
    repo.setSourceVideos(second.id, [
      { id: 'vid1', position: 0 },
      { id: 'vid2', position: 1 },
    ]);
    repo.upsertThread(thread('t1', { likeCount: 4 }, [{ id: 't1.r1', likeCount: 2 }]));
    repo.upsertThread(thread('t2', { videoId: 'vid2', likeCount: 1 }));

    const s = repo.getStats();
    expect(s.totals).toMatchObject({
      videos: 2,
      videosWithDetails: 2,
      durationSeconds: 690,
      videoLikes: 10,
      commentsOnYoutube: 15,
      views: 200,
    });
    // vid1 is in both sources but the per-source rows each count it.
    const rows = Object.fromEntries(s.bySource.map((r) => [r.title, r]));
    expect(rows['P']!.videos).toBe(1);
    expect(rows['Mine']!.videos).toBe(2);
    expect(rows['Mine']!.isOwn).toBe(true);
    expect(s.mine.videos).toBe(2);
    expect(s.totals).toMatchObject({ commentsSynced: 3, commentLikes: 7 });
  });

  it('reports videos without details and keeps known values when a later fetch lacks them', () => {
    repo.upsertVideos([vid('vid1', { durationSeconds: null, likeCount: null })]);
    expect(repo.videosMissingDetails()).toEqual(['vid1']);
    expect(repo.getStats().totals.videosWithDetails).toBe(0);
    repo.upsertVideos([vid('vid1')]);
    expect(repo.videosMissingDetails()).toEqual([]);
    repo.upsertVideos([vid('vid1', { durationSeconds: null, likeCount: null })]);
    expect(repo.getStats().totals).toMatchObject({ durationSeconds: 600, videoLikes: 7 });
  });

  it('ignores missing videos', () => {
    repo.upsertVideos([vid('vid1')]);
    repo.updateVideoSync('vid1', { missing: true });
    expect(repo.getStats().totals.videos).toBe(0);
  });
});
