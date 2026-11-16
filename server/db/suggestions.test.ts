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
  it('keeps one current row per item', () => {
    repo.suggestions.save(row(1));
    repo.suggestions.save(row(1, { stateKey: 'k2', reason: 'Newer', costUsd: 0.5 }));
    repo.suggestions.save(row(2, { createdAt: '2026-11-11T23:59:59.000Z', costUsd: 1 }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM suggestions').get()).toEqual({ n: 2 });
    expect(repo.suggestions.get([id(1)]).get(id(1))?.reason).toBe('Newer');
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

describe('filtering the inbox by suggestion', () => {
  const ids = (suggestion: Parameters<Repo['listInbox']>[0]['suggestion']) =>
    repo
      .listInbox({ view: 'inbox', ...(suggestion ? { suggestion } : {}) })
      .items.map((i) => i.item.id)
      .sort();

  beforeEach(() => {
    repo.suggestions.save(row(1, { verdict: 'needs_reply', turn: 'matt' }));
    repo.suggestions.save(row(2, { verdict: 'no_reply_needed', turn: 'them' }));
    repo.suggestions.save(row(3, { verdict: 'needs_action', injectionAttempt: true, turn: 'matt' }));
    // Item 4 has none yet.
  });

  it('picks items by verdict, by whose turn it is, as suspicious, or as having none yet', () => {
    expect(ids('reply')).toEqual([id(1)]);
    expect(ids('skip')).toEqual([id(2)]);
    expect(ids('matt')).toEqual([id(1)]);
    expect(ids('them')).toEqual([id(2)]);
    expect(ids('suspicious')).toEqual([id(3)]);
    expect(ids('none')).toEqual([id(4)]);
    expect(ids(undefined)).toHaveLength(4);
  });

  it('never matches a suspicious item by its hidden verdict', () => {
    expect(ids('act')).toEqual([]);
  });

  it('counts and pages only the filtered items, newest or oldest first', () => {
    const q = { view: 'inbox' as const, suggestion: 'none' as const };
    expect(repo.listInbox(q).total).toBe(1);
    repo.suggestions.save(row(4));
    expect(repo.listInbox({ ...q, suggestion: 'reply', order: 'oldest', limit: 1 })).toMatchObject({
      total: 2,
      items: [expect.objectContaining({ item: expect.objectContaining({ id: id(1) }) })],
    });
  });
});

describe('suggestion progress', () => {
  it('counts inbox items and those with a current suggestion (a rule, or this prompt version)', () => {
    repo.suggestions.save(row(1, { promptVersion: 'now' }));
    repo.suggestions.save(row(2, { promptVersion: 'old' }));
    repo.suggestions.save(row(3, { promptVersion: 'rule:x', model: 'rules' }));
    expect(repo.suggestions.progress('now')).toEqual({ total: 4, done: 2 });
    repo.triage([id(1)], 'done');
    expect(repo.suggestions.progress('now')).toEqual({ total: 3, done: 1 });
  });
});

describe('recording the suggestion with what the owner did', () => {
  it("adds suggested and suggestedConfidence to the owner's state and snooze events", () => {
    repo.suggestions.save(row(1, { verdict: 'no_reply_needed', confidence: 'low' }));
    repo.triage([id(1)], 'done');
    expect(metaOf(id(1), 'state')).toMatchObject({ suggested: 'skip', suggestedConfidence: 'low' });

    repo.suggestions.save(row(2, { verdict: 'needs_action' }));
    const r = repo.snooze([id(2)], new Date(Date.now() + 3_600_000).toISOString());
    expect(metaOf(id(2), 'snooze')).toEqual({
      actionId: r.actionId,
      suggested: 'act',
      suggestedConfidence: 'medium',
      suggestedCategory: 'question',
      suggestedPrompt: 'p0-7',
    });
  });

  it('keeps the category and prompt version the suggestion had when he acted, even after it is replaced', () => {
    repo.suggestions.save(row(1, { verdict: 'no_reply_needed', category: 'chat', promptVersion: 'p1-2' }));
    repo.triage([id(1)], 'done', 'no_action');
    repo.suggestions.save(row(1, { category: 'question', promptVersion: 'p1-3' })); // a later run replaces the row
    expect(metaOf(id(1), 'state')).toMatchObject({
      suggested: 'skip',
      suggestedCategory: 'chat',
      suggestedPrompt: 'p1-2',
    });
  });

  it('records no category or prompt for an injection attempt, nor without a suggestion', () => {
    repo.suggestions.save(row(1, { injectionAttempt: true, category: 'other' }));
    repo.triage([id(1), id(2)], 'done');
    for (const n of [1, 2]) {
      const m = metaOf(id(n), 'state');
      expect(m).not.toHaveProperty('suggestedCategory');
      expect(m).not.toHaveProperty('suggestedPrompt');
      expect(m).not.toHaveProperty('suggested');
    }
  });

  it('tags decision and reply events with the category too, but leaves a caller-given suggestion alone', () => {
    repo.suggestions.save(row(1, { category: 'bug' }));
    const ev = createEvents(db);
    ev.record({ itemId: id(1), at: '2026-11-12T10:00:00.000Z', kind: 'decision', to: 'done', source: 'user' });
    expect(metaOf(id(1), 'decision')).toMatchObject({ suggestedCategory: 'bug', suggestedPrompt: 'p0-7' });
    ev.record({
      itemId: id(1),
      at: '2026-11-12T10:00:00.000Z',
      kind: 'reply',
      source: 'user',
      meta: { suggested: 'skip' },
    });
    expect(metaOf(id(1), 'reply')).not.toHaveProperty('suggestedCategory');
  });

  it('works on a database from before migration 12 (no turn column), still with category and prompt', () => {
    const old = openDb(':memory:');
    // openDb migrates fully; rebuild the table without the 012 columns to get the older shape.
    old.exec(`CREATE TABLE s2 AS SELECT item_id, state_key, verdict, category, confidence, reason, injection_attempt,
                model, prompt_version, input_tokens, output_tokens, cost_usd, created_at FROM suggestions`);
    old.exec('DROP TABLE suggestions');
    old.exec('ALTER TABLE s2 RENAME TO suggestions');
    old
      .prepare(
        `INSERT INTO suggestions (item_id, state_key, verdict, category, confidence, reason, injection_attempt, model,
         prompt_version, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ('x', 'k', 'needs_reply', 'question', 'high', 'r', 0, 'm', 'p0-1', 0, 0, 0, '2026-01-01')`,
      )
      .run();
    createEvents(old).record({
      itemId: 'x',
      at: '2026-11-12T10:00:00.000Z',
      kind: 'state',
      to: 'done',
      source: 'user',
    });
    const m = JSON.parse((old.prepare('SELECT meta FROM item_events').get() as { meta: string }).meta);
    expect(m).toEqual({
      suggested: 'reply',
      suggestedConfidence: 'high',
      suggestedCategory: 'question',
      suggestedPrompt: 'p0-1',
    });
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
    to: 'done' | 'dismissed' | 'legacy_done' | 'replied' | 'snooze',
    at = '2026-11-12T10:00:00.000Z',
  ) {
    // New done events name their reason; a done with none was recorded before dismissals existed.
    const reason = to === 'done' ? { reason: 'done' } : to === 'dismissed' ? { reason: 'no_action' } : {};
    const meta = suggested ? { suggested, suggestedConfidence: 'high', ...reason, ...turns[n] } : { ...reason };
    const state = to === 'dismissed' || to === 'legacy_done' ? 'done' : to;
    const ev = createEvents(db);
    if (to === 'snooze')
      ev.record({
        itemId: id(n),
        at,
        kind: 'snooze',
        from: null,
        to: '2026-11-13T00:00:00.000Z',
        source: 'user',
        meta,
      });
    else ev.record({ itemId: id(n), at, kind: 'state', from: 'inbox', to: state, source: 'user', meta });
  }

  it('compares the suggestion with the first thing the owner did, by verdict', () => {
    act(1, 'reply', 'replied');
    act(2, 'reply', 'done');
    act(3, 'skip', 'dismissed');
    act(3, 'skip', 'replied', '2026-11-12T11:00:00.000Z'); // later actions do not count
    act(4, 'act', 'snooze');
    act(4, null, 'done', '2026-11-12T12:00:00.000Z');
    const rep = habitsReport(db);
    expect(rep.suggestionHits).toEqual([
      {
        suggested: 'reply',
        total: 2,
        hits: 1,
        ambiguous: 0,
        byAction: { replied: 1, done: 1 },
        byTurn: { them: 1, matt: 1 },
      },
      { suggested: 'act', total: 1, hits: 1, ambiguous: 0, byAction: { snooze: 1 }, byTurn: { none: 1 } },
      { suggested: 'skip', total: 1, hits: 1, ambiguous: 0, byAction: { dismissed: 1 }, byTurn: { none: 1 } },
    ]);
    const text = formatHabits(rep);
    expect(text).toContain('suggested reply: 50.0% (1/2) agreed (replied 1, done 1)');
    expect(text).toContain('suggested skip: 100.0% (1/1) agreed (dismissed 1)');
    expect(text).toContain('whose turn the model said: them 1, matt 1');
  });

  it('judges skip against dismissed, act against done, and reports a bare old done as ambiguous', () => {
    act(1, 'skip', 'done'); // he did it: the suggestion said nothing was needed
    act(2, 'act', 'done');
    act(3, 'skip', 'legacy_done'); // from before dismissals existed: could be either
    act(4, 'act', 'legacy_done');
    act(5, 'reply', 'legacy_done'); // not a reply whichever he meant: a miss
    const rep = habitsReport(db);
    const by = Object.fromEntries(rep.suggestionHits.map((h) => [h.suggested, h]));
    expect(by.skip).toMatchObject({ total: 1, hits: 0, ambiguous: 1 });
    expect(by.act).toMatchObject({ total: 1, hits: 1, ambiguous: 1 });
    expect(by.reply).toMatchObject({ total: 1, hits: 0, ambiguous: 0 });
    expect(rep.suggestionSummary.single).toEqual({ total: 3, hits: 1, ambiguous: 2 });
    const text = formatHabits(rep);
    expect(text).toContain('2 not counted (done (before dismissals existed))');
    expect(text).toContain('suggested skip: 0.0% (0/1) agreed (done 1, done (before dismissals existed) 1)');
  });

  it('records the dismissal reason on events the app writes, and counts dismissed apart from done', () => {
    repo.suggestions.save(row(1, { verdict: 'no_reply_needed' }));
    repo.suggestions.save(row(2, { verdict: 'no_reply_needed' }));
    repo.triage([id(1)], 'done', 'no_action');
    repo.triage([id(2)], 'done');
    const rep = habitsReport(db);
    expect(rep.actionMix).toEqual(
      expect.arrayContaining([
        { provider: 'github', kind: 'pr', action: 'dismissed', count: 1 },
        { provider: 'github', kind: 'pr', action: 'done', count: 1 },
      ]),
    );
    expect(rep.suggestionHits).toMatchObject([
      { suggested: 'skip', total: 2, hits: 1, byAction: { dismissed: 1, done: 1 } },
    ]);
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

  describe('bulk actions are reported apart from single decisions', () => {
    it('counts items changed by one action together as bulk, whatever the suggestion said', () => {
      repo.suggestions.save(row(1, { verdict: 'no_reply_needed' }));
      repo.suggestions.save(row(2, { verdict: 'no_reply_needed' }));
      repo.suggestions.save(row(3, { verdict: 'needs_reply' }));
      repo.suggestions.save(row(4, { verdict: 'needs_reply' }));
      repo.triage([id(1), id(2)], 'done', 'no_action'); // one action, two items: bulk
      repo.triage([id(3)], 'replied'); // alone: single, and agreed
      repo.triage([id(4)], 'done'); // alone: single, and disagreed
      const rep = habitsReport(db);
      expect(rep.suggestionSummary).toEqual({
        single: { total: 2, hits: 1, ambiguous: 0 },
        bulk: { total: 2, hits: 2, ambiguous: 0 },
      });
      expect(rep.suggestionHits.map((h) => [h.suggested, h.total, h.hits])).toEqual([['reply', 2, 1]]);
      expect(rep.suggestionHitsBulk.map((h) => [h.suggested, h.total, h.hits])).toEqual([['skip', 2, 2]]);
      const text = formatHabits(rep);
      expect(text).toContain('single decisions: 2, agreed 50.0% (1/2)');
      expect(text).toContain('bulk: 2, agreed 100.0% (2/2)');
      expect(text).toContain('bulk actions:');
    });

    it('also trusts the browser decision event when it says bulk (a bulk of items that were already done)', () => {
      repo.suggestions.save(row(1, { verdict: 'needs_reply' }));
      repo.triage([id(1)], 'done');
      db.prepare(
        "INSERT INTO item_events (item_id, at, kind, to_value, source, meta) VALUES (?, ?, 'decision', 'done', 'user', ?)",
      ).run(id(1), new Date().toISOString(), JSON.stringify({ bulk: true, selectionSize: 40 }));
      expect(habitsReport(db).suggestionSummary).toEqual({
        single: { total: 0, hits: 0, ambiguous: 0 },
        bulk: { total: 1, hits: 0, ambiguous: 0 },
      });
    });

    it('ignores a bulk decision for the same item from a long time ago', () => {
      repo.suggestions.save(row(1, { verdict: 'needs_reply' }));
      db.prepare(
        "INSERT INTO item_events (item_id, at, kind, to_value, source, meta) VALUES (?, '2020-01-01T00:00:00.000Z', 'decision', 'inbox', 'user', ?)",
      ).run(id(1), JSON.stringify({ bulk: true }));
      repo.triage([id(1)], 'replied');
      expect(habitsReport(db).suggestionSummary.single).toEqual({ total: 1, hits: 1, ambiguous: 0 });
    });
  });

  it('says so when no suggestion was ever acted on', () => {
    act(1, null, 'done');
    expect(habitsReport(db).suggestionHits).toEqual([]);
    expect(formatHabits(habitsReport(db))).toContain('Suggestion hit rate');
  });
});
