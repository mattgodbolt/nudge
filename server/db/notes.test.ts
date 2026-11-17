import { beforeEach, describe, expect, it } from 'vitest';
import type { GithubItemUpsert, Repo } from '../contracts.js';
import { githubItemId } from './feeds.js';
import { openDb, type Db } from './db.js';
import { createRepo } from './repo.js';
import { MAX_STANDING_IN_PROMPT, NOTE_TEXT_MAX } from './notes.js';

let t = Date.parse('2026-11-12T10:00:00.000Z');
const now = () => new Date(t);
let db: Db;
let repo: Repo;
let feedId: number;
const id = (n: number) => githubItemId('org', 'app', n);
const pr = (n: number, over: Partial<GithubItemUpsert> = {}): GithubItemUpsert => ({
  id: id(n),
  kind: 'pr',
  repo: 'org/app',
  number: n,
  title: `PR ${n}`,
  author: 'bob',
  authorAvatarUrl: null,
  authorType: 'User',
  association: 'CONTRIBUTOR',
  bodyPlain: 'body',
  url: `https://github.com/org/app/pull/${n}`,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
  sourceState: 'open',
  draft: false,
  comments: 0,
  labels: [],
  ...over,
});
const add = (text: string, over: Partial<Parameters<Repo['notes']['add']>[0]> = {}) =>
  repo.notes.add({ text, scope: 'item', source: 'text', itemId: null, ...over });

beforeEach(() => {
  t = Date.parse('2026-11-12T10:00:00.000Z');
  db = openDb(':memory:');
  repo = createRepo(db, now);
  feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' }).id;
  repo.upsertGithubItems(feedId, [pr(1, { comments: 3, lastCommenter: 'bob', lastCommenterIsMe: false }), pr(2)]);
});

describe('notes', () => {
  it('stores the words verbatim with when, where from and nothing else when there is no item', () => {
    const n = add('  I never want to see   lockfile bumps  ', { scope: 'standing', source: 'voice' });
    expect(n).toMatchObject({
      text: 'I never want to see   lockfile bumps',
      originalText: 'I never want to see   lockfile bumps',
      scope: 'standing',
      source: 'voice',
      enabled: true,
      itemId: null,
      suggestion: null,
      lastAction: null,
      context: null,
      createdAt: '2026-11-12T10:00:00.000Z',
    });
  });

  it('snapshots the suggestion showing, what the owner had just done with why, and the item context', () => {
    db.prepare(
      `INSERT INTO suggestions (item_id, state_key, verdict, category, confidence, reason, model, prompt_version,
         created_at, turn, next_step) VALUES (?, 'k', 'needs_reply', 'question', 'high', 'A feature request', 'm', 'p',
         't', 'me', 'Review the fix')`,
    ).run(id(1));
    repo.snooze([id(1)], new Date(t + 86_400_000).toISOString(), 'review the proposed fix');
    t += 60_000;
    const n = add("I wouldn't have snoozed that, it's from my friend Bob", { itemId: id(1) });
    expect(n.itemTitle).toBe('PR 1');
    expect(n.suggestion).toEqual({
      verdict: 'needs_reply',
      action: 'reply',
      turn: 'me',
      nextStep: 'Review the fix',
      reason: 'A feature request',
      confidence: 'high',
    });
    expect(n.lastAction).toMatchObject({
      kind: 'snooze',
      why: 'review the proposed fix',
      at: '2026-11-12T10:00:00.000Z',
    });
    expect(n.context).toEqual({
      provider: 'github',
      kind: 'pr',
      container: 'org/app',
      author: 'bob',
      comments: 3,
      lastCommenter: 'bob',
    });
  });

  it('ignores an action more than an hour old', () => {
    repo.triage([id(1)], 'done');
    t += 61 * 60_000;
    expect(add('too late', { itemId: id(1) }).lastAction).toBeNull();
    expect(repo.notes.recentAction()).toBeNull();
  });

  it('finds the most recent action on any item, for "that" when nothing is selected', () => {
    repo.triage([id(1)], 'done');
    t += 1000;
    repo.snooze([id(2)], new Date(t + 86_400_000).toISOString(), 'later');
    expect(repo.notes.recentAction()).toMatchObject({ itemId: id(2), kind: 'snooze', why: 'later' });
  });

  it('edits keep what was first said; deleting really deletes', () => {
    const n = add('first words');
    const edited = repo.notes.update(n.id, { text: ' second words ', enabled: false })!;
    expect(edited).toMatchObject({ text: 'second words', originalText: 'first words', enabled: false });
    expect(repo.notes.list().map((x) => x.id)).toEqual([n.id]);
    expect(repo.notes.remove(n.id)?.id).toBe(n.id);
    expect(repo.notes.list()).toEqual([]);
    expect(repo.notes.update(n.id, { text: 'x' })).toBeNull();
  });

  it('lists newest first and clips very long text', () => {
    const a = add('a');
    const b = add('b'.repeat(NOTE_TEXT_MAX + 50));
    expect(repo.notes.list().map((n) => n.id)).toEqual([b.id, a.id]);
    expect(b.text).toHaveLength(NOTE_TEXT_MAX);
  });

  it('outlives its item', () => {
    add('about PR 1', { itemId: id(1) });
    db.prepare('DELETE FROM items WHERE id = ?').run(id(1));
    expect(repo.notes.list()).toHaveLength(1);
  });

  describe('what the model is shown', () => {
    it('standing notes: enabled ones only, capped to the newest, with a fingerprint that follows them', () => {
      expect(repo.notes.standing()).toEqual({ texts: [], hash: '' });
      const a = add('Bob matters', { scope: 'standing' });
      add('about one item', { itemId: id(1) });
      const h1 = repo.notes.standing();
      expect(h1.texts).toEqual(['Bob matters']);
      repo.notes.update(a.id, { enabled: false });
      expect(repo.notes.standing()).toEqual({ texts: [], hash: '' });
      repo.notes.update(a.id, { enabled: true });
      expect(repo.notes.standing().hash).toBe(h1.hash);
      repo.notes.update(a.id, { text: 'Bob matters a lot' });
      expect(repo.notes.standing().hash).not.toBe(h1.hash);
      for (let i = 0; i < MAX_STANDING_IN_PROMPT + 5; i++) add(`n${i}`, { scope: 'standing' });
      const s = repo.notes.standing();
      expect(s.texts).toHaveLength(MAX_STANDING_IN_PROMPT);
      expect(s.texts.at(-1)).toBe(`n${MAX_STANDING_IN_PROMPT + 4}`);
    });

    it('item notes: only for that item, newest first, enabled only', () => {
      const a = add('one', { itemId: id(1) });
      add('two', { itemId: id(1) });
      add('other', { itemId: id(2) });
      add('standing about it', { itemId: id(1), scope: 'standing' });
      expect(repo.notes.forItem(id(1))).toEqual(['two', 'one']);
      repo.notes.update(a.id, { enabled: false });
      expect(repo.notes.forItem(id(1))).toEqual(['two']);
    });
  });
});
