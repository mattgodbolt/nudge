import { beforeEach, describe, expect, it } from 'vitest';
import type { GithubItemUpsert, Repo } from '../contracts.js';
import { githubItemId } from './feeds.js';
import { openDb, type Db } from './db.js';
import { createRepo } from './repo.js';

let t = Date.parse('2026-11-12T10:00:00.000Z');
let db: Db;
let repo: Repo;
const id = (n: number) => githubItemId('org', 'app', n);
const pr = (n: number): GithubItemUpsert => ({
  id: id(n),
  kind: 'pr',
  repo: 'org/app',
  number: n,
  title: `PR ${n}`,
  author: 'carol',
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
});
const later = (ms: number) => new Date(t + ms).toISOString();
const item = (n: number) => repo.listInbox({ view: 'all' }).items.find((i) => i.item.id === id(n))!;
const snoozeEvents = (n: number) =>
  (
    db.prepare("SELECT meta FROM item_events WHERE item_id = ? AND kind = 'snooze' ORDER BY id").all(id(n)) as {
      meta: string | null;
    }[]
  ).map((r) => (r.meta ? JSON.parse(r.meta) : null));

beforeEach(() => {
  t = Date.parse('2026-11-12T10:00:00.000Z');
  db = openDb(':memory:');
  repo = createRepo(db, () => new Date(t));
  const feed = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' });
  repo.upsertGithubItems(feed.id, [pr(1), pr(2), pr(3)]);
});

describe('snooze why', () => {
  it('is kept on the item and on the snooze event, and shown while snoozed and after it wakes', () => {
    const r = repo.snooze([id(1)], later(3_600_000), '  review the proposed fix  ');
    expect(item(1).snoozeWhy).toBe('review the proposed fix');
    expect(snoozeEvents(1)[0]).toMatchObject({ actionId: r.actionId, why: 'review the proposed fix' });
    t += 2 * 3_600_000;
    repo.wakeSnoozed();
    expect(item(1)).toMatchObject({ snoozedUntil: null, snoozeWhy: 'review the proposed fix' });
    expect(item(1).wokeAt).not.toBeNull();
  });

  it('is optional: no why means none stored, and an old one is replaced', () => {
    repo.snooze([id(1)], later(3_600_000));
    expect(item(1).snoozeWhy).toBeNull();
    expect(snoozeEvents(1)[0]).not.toHaveProperty('why');
    repo.snooze([id(1)], later(7_200_000), 'first reason');
    repo.snooze([id(1)], later(9_000_000));
    expect(item(1).snoozeWhy).toBeNull();
  });

  it('applies one why to every item of a bulk snooze', () => {
    repo.snooze([id(1), id(2)], later(3_600_000), 'after the release');
    expect(item(1).snoozeWhy).toBe('after the release');
    expect(item(2).snoozeWhy).toBe('after the release');
    expect(item(3).snoozeWhy).toBeNull();
  });

  it('is not shown for an item that was never snoozed, nor once unsnoozed back to nothing', () => {
    expect(item(3).snoozeWhy).toBeNull();
    repo.snooze([id(1)], later(3_600_000), 'a reason');
    repo.snooze([id(1)], null);
    expect(item(1)).toMatchObject({ snoozedUntil: null, snoozeWhy: null });
  });

  it('undo restores the reason the item had before', () => {
    repo.snooze([id(1)], later(3_600_000), 'first');
    const second = repo.snooze([id(1)], later(7_200_000), 'second');
    expect(item(1).snoozeWhy).toBe('second');
    repo.undoSnooze(second.actionId!);
    expect(item(1)).toMatchObject({ snoozedUntil: later(3_600_000), snoozeWhy: 'first' });
  });
});
