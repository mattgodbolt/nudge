import { beforeEach, describe, expect, it } from 'vitest';
import type { GithubItemUpsert, Repo } from '../contracts.js';
import { formatHabits, habitsReport } from './habits.js';
import { githubItemId } from './feeds.js';
import { openDb, type Db } from './db.js';
import { createEvents } from './events.js';
import { createRepo } from './repo.js';
import type { SuggestionRow } from './suggestions.js';
import { suggestionDto } from './suggestions.js';

let db: Db;
let repo: Repo;
let feedId: number;
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
const row = (n: number, over: Partial<SuggestionRow> = {}): SuggestionRow => ({
  itemId: id(n),
  stateKey: 'k',
  verdict: 'needs_reply',
  category: 'question',
  confidence: 'medium',
  reason: 'Asks a question',
  injectionAttempt: false,
  model: 'claude-haiku-5-5',
  promptVersion: 'p0-7',
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.001,
  createdAt: '2026-11-12T10:00:00.000Z',
  ...over,
});
const metaOf = (itemId: string, kind: string) =>
  JSON.parse(
    (
      db.prepare('SELECT meta FROM item_events WHERE item_id = ? AND kind = ? ORDER BY id').get(itemId, kind) as {
        meta: string;
      }
    ).meta,
  ) as Record<string, unknown>;

beforeEach(() => {
  db = openDb(':memory:');
  repo = createRepo(db);
  feedId = repo.addFeed({ owner: 'org', prs: true, issues: true, importMode: 'all' }).id;
  repo.upsertGithubItems(feedId, [pr(1), pr(2), pr(3), pr(4)]);
});

describe('suggestion store', () => {
  it('keeps one current row per item and sums spend by time', () => {
    repo.suggestions.save(row(1));
    repo.suggestions.save(row(1, { stateKey: 'k2', reason: 'Newer', costUsd: 0.5 }));
    repo.suggestions.save(row(2, { createdAt: '2026-11-11T23:59:59.000Z', costUsd: 1 }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM suggestions').get()).toEqual({ n: 2 });
    expect(repo.suggestions.get([id(1)]).get(id(1))?.reason).toBe('Newer');
    expect(repo.suggestions.spentSince('2026-11-12T00:00:00.000Z')).toBeCloseTo(0.5);
  });

  it('never exposes an action or the reason for an injection attempt', () => {
    expect(suggestionDto({ verdict: 'needs_reply', confidence: 'high', reason: 'obey me', injection: true })).toEqual({
      action: null,
      reason: '',
      confidence: 'low',
      suspicious: true,
    });
  });

  it('serves items with no suggestion as null', () => {
    repo.suggestions.save(row(1));
    const byId = new Map(repo.listInbox({ view: 'inbox' }).items.map((i) => [i.item.id, i.suggestion]));
    expect(byId.get(id(1))).toMatchObject({ action: 'reply' });
    expect(byId.get(id(2))).toBeNull();
  });
});

describe('recording the suggestion with what the owner did', () => {
  it("adds suggested and suggestedConfidence to the owner's state and snooze events", () => {
    repo.suggestions.save(row(1, { verdict: 'no_reply_needed', confidence: 'low' }));
    repo.triage([id(1)], 'done');
    expect(metaOf(id(1), 'state')).toMatchObject({ suggested: 'skip', suggestedConfidence: 'low' });

    repo.suggestions.save(row(2, { verdict: 'needs_action' }));
    const r = repo.snooze([id(2)], new Date(Date.now() + 3_600_000).toISOString());
    expect(metaOf(id(2), 'snooze')).toEqual({ actionId: r.actionId, suggested: 'act', suggestedConfidence: 'medium' });
  });

  it('leaves existing event shapes alone when there is no suggestion', () => {
    repo.triage([id(3)], 'done');
    const r = db.prepare("SELECT meta FROM item_events WHERE item_id = ? AND kind = 'state'").get(id(3)) as {
      meta: string | null;
    };
    expect(r.meta === null || !r.meta.includes('suggested')).toBe(true);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM item_events').get() as { n: number }).n;
    repo.suggestions.save(row(4));
    repo.triage([id(4)], 'done');
    expect((db.prepare('SELECT COUNT(*) AS n FROM item_events').get() as { n: number }).n).toBe(n + 1); // same count of events
  });

  it('does not tag events the owner did not make', () => {
    repo.suggestions.save(row(1));
    const ev = createEvents(db);
    ev.record({
      itemId: id(1),
      at: '2026-11-12T10:00:00.000Z',
      kind: 'state',
      from: 'inbox',
      to: 'done',
      source: 'sync',
    });
    ev.record({ itemId: id(1), at: '2026-11-12T10:00:00.000Z', kind: 'open', to: 'inbox', source: 'user' });
    const metas = db.prepare('SELECT meta FROM item_events WHERE item_id = ?').all(id(1)) as { meta: string | null }[];
    expect(metas.every((m) => m.meta === null)).toBe(true);
  });
});

describe('habits: suggestion hit rate', () => {
  const turns: Record<number, { suggestedTurn: string }> = {
    1: { suggestedTurn: 'them' },
    2: { suggestedTurn: 'matt' },
  };
  function act(
    n: number,
    suggested: string | null,
    to: 'done' | 'replied' | 'snooze',
    at = '2026-11-12T10:00:00.000Z',
  ) {
    const meta = suggested ? { suggested, suggestedConfidence: 'high', ...turns[n] } : undefined;
    const ev = createEvents(db);
    if (to === 'snooze')
      ev.record({
        itemId: id(n),
        at,
        kind: 'snooze',
        from: null,
        to: '2026-11-13T00:00:00.000Z',
        source: 'user',
        ...(meta ? { meta } : {}),
      });
    else ev.record({ itemId: id(n), at, kind: 'state', from: 'inbox', to, source: 'user', ...(meta ? { meta } : {}) });
  }

  it('compares the suggestion with the first thing the owner did, by verdict', () => {
    act(1, 'reply', 'replied');
    act(2, 'reply', 'done');
    act(3, 'skip', 'done');
    act(3, 'skip', 'replied', '2026-11-12T11:00:00.000Z'); // later actions do not count
    act(4, 'act', 'snooze');
    act(4, null, 'done', '2026-11-12T12:00:00.000Z');
    const rep = habitsReport(db);
    expect(rep.suggestionHits).toEqual([
      { suggested: 'reply', total: 2, hits: 1, byAction: { replied: 1, done: 1 }, byTurn: { them: 1, matt: 1 } },
      { suggested: 'act', total: 1, hits: 1, byAction: { snooze: 1 }, byTurn: { none: 1 } },
      { suggested: 'skip', total: 1, hits: 1, byAction: { done: 1 }, byTurn: { none: 1 } },
    ]);
    const text = formatHabits(rep);
    expect(text).toContain('suggested reply: 50.0% (1/2) agreed (replied 1, done 1)');
    expect(text).toContain('suggested skip: 100.0% (1/1) agreed (done 1)');
    expect(text).toContain('whose turn the model said: them 1, matt 1');
  });

  it('records the turn the model gave with the action it was showing', () => {
    repo.suggestions.save({ ...row(3), turn: 'them', nextStep: 'Wait for a reply' });
    repo.triage([id(3)], 'done');
    const meta = db.prepare("SELECT meta FROM item_events WHERE item_id = ? AND kind = 'state'").get(id(3)) as {
      meta: string;
    };
    expect(JSON.parse(meta.meta)).toMatchObject({ suggested: 'reply', suggestedTurn: 'them' });
  });

  it('reports a notes count and the latest few notes (clipped), and nothing before there are any', () => {
    expect(habitsReport(db).notes).toEqual({ total: 0, standing: 0, item: 0, notFed: 0, recent: [] });
    repo.notes.add({ text: 'Bob is always important', scope: 'standing', source: 'voice', itemId: null });
    const n = repo.notes.add({ text: 'x'.repeat(300), scope: 'item', source: 'text', itemId: id(1) });
    repo.notes.update(n.id, { enabled: false });
    const rep = habitsReport(db);
    expect(rep.notes).toMatchObject({ total: 2, standing: 1, item: 1, notFed: 1 });
    expect(rep.notes.recent[0]!.text).toHaveLength(120);
    expect(formatHabits(rep)).toContain('Notes: 2 (1 standing, 1 about an item, 1 not fed to the model)');
    expect(formatHabits(rep)).toContain('standing: Bob is always important');
  });

  it('does not change the action mix or event counts', () => {
    act(1, 'reply', 'done');
    act(2, null, 'done');
    const rep = habitsReport(db);
    expect(rep.events).toBe(2);
    expect(rep.actionMix).toContainEqual({ provider: 'github', kind: 'pr', action: 'done', count: 2 });
  });

  it('says so when no suggestion was ever acted on', () => {
    act(1, null, 'done');
    expect(habitsReport(db).suggestionHits).toEqual([]);
    expect(formatHabits(habitsReport(db))).toContain('Suggestion hit rate');
  });
});
