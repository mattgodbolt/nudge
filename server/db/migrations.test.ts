import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db.js';
import { createRepo } from './repo.js';
import { MIGRATIONS } from './migrations.js';

describe('migration 003 (google accounts + reply posts)', () => {
  it('upgrades a v2 database in place, keeping rows and bumping user_version to the latest', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS[0]! + MIGRATIONS[1]!);
    db.pragma('user_version = 2');
    db.prepare("INSERT INTO videos (id, title) VALUES ('v', 'T')").run();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'google_accounts'").get()).toBeUndefined();

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT title FROM videos').get()).toEqual({ title: 'T' });
    db.prepare(
      "INSERT INTO google_accounts (channel_id, refresh_token, scope, connected_at) VALUES ('UC1', 'r', 's', 'now')",
    ).run();
    expect(db.prepare('SELECT needs_reauth, is_default FROM google_accounts').get()).toEqual({
      needs_reauth: 0,
      is_default: 0,
    });
    expect(() =>
      db
        .prepare("INSERT INTO reply_posts (comment_id, body_hash, status, created_at) VALUES ('c','h','bogus','n')")
        .run(),
    ).toThrow();
  });
});

const tableNames = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

describe('migration 005 (snooze + labels)', () => {
  it('upgrades a v4 database in place, keeping comments and the FTS index', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS.slice(0, 4).join('\n'));
    db.pragma('user_version = 4');
    db.prepare("INSERT INTO videos (id, title) VALUES ('v', 'T')").run();
    db.prepare(
      "INSERT INTO threads (id, video_id, top_comment_id, last_activity_at) VALUES ('t', 'v', 'c1', '2024-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      `INSERT INTO comments (id, thread_id, video_id, author_name, text_html, text_plain, published_at, updated_at,
         first_seen_at, state, state_changed_at, state_source)
       VALUES ('c1', 't', 'v', 'A', 'hello', 'hello', 'x', 'x', 'x', 'inbox', 'x', 'sync')`,
    ).run();

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT id, snoozed_until, woke_at FROM items').get()).toEqual({
      id: 'c1',
      snoozed_until: null,
      woke_at: null,
    });
    expect(
      db
        .prepare("SELECT id FROM items WHERE rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH 'hello')")
        .all(),
    ).toHaveLength(1);
  });

  it('created labels whose links cascade away with the label (the schema as it stood before migration 015)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS.slice(0, 14).join('\n'));
    db.prepare(
      "INSERT INTO items (id, provider, kind, state, state_source, state_changed_at, first_seen_at, occurred_at) VALUES ('c1', 'youtube', 'comment', 'inbox', 'sync', 'x', 'x', 'x')",
    ).run();
    db.prepare("INSERT INTO labels (name, color, position, created_at) VALUES ('Q', 'red', 1, 'n')").run();
    db.prepare("INSERT INTO item_labels VALUES ('c1', 1)").run();
    db.prepare('DELETE FROM labels WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM item_labels').get()).toEqual({ n: 0 });
  });
});

describe('migration 007 (items)', () => {
  /** A v6 database with a spread of states, a snooze, labels and drafts, built by the real earlier migrations. */
  function v6() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS.slice(0, 6).join('\n'));
    db.pragma('user_version = 6');
    db.prepare("INSERT INTO videos (id, title) VALUES ('v', 'Video title')").run();
    db.prepare(
      "INSERT INTO threads (id, video_id, top_comment_id, last_activity_at) VALUES ('t', 'v', 'c1', '2024-01-01T00:00:00.000Z')",
    ).run();
    const add = db.prepare(
      `INSERT INTO comments (id, thread_id, video_id, author_name, author_avatar_url, text_html, text_plain,
         published_at, updated_at, first_seen_at, is_own, state, state_changed_at, state_source, snoozed_until, woke_at)
       VALUES (?, 't', 'v', ?, 'http://a', ?, ?, ?, 'x', 'seen', ?, ?, 'changed', ?, ?, ?)`,
    );
    add.run('c1', 'Ann', 'hello world', 'hello world', '2024-01-01', 0, 'inbox', 'sync', null, null);
    add.run('c2', 'Bob', 'second', 'second', '2024-01-02', 0, 'done', 'user', null, null);
    add.run('c3', 'Cy', 'snoozed one', 'snoozed one', '2024-01-03', 0, 'inbox', 'sync', '2999-01-01', null);
    add.run('c4', 'Me', 'mine', 'mine', '2024-01-04', 1, 'own', 'sync', null, '2024-02-01');
    db.prepare("INSERT INTO labels (id, name, color, position, created_at) VALUES (1, 'Q', 'red', 1, 'n')").run();
    db.prepare("INSERT INTO comment_labels VALUES ('c1', 1), ('c3', 1)").run();
    db.prepare(
      "INSERT INTO drafts (comment_id, body, updated_at, status) VALUES ('c2', 'draft body', 'n', 'draft')",
    ).run();
    return db;
  }

  it('carries every comment across with its state, snooze, draft and searchable text', () => {
    const db = v6();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(
      db
        .prepare(
          'SELECT id, provider, kind, container_key, container_title, author, is_own, state, state_source, snoozed_until, woke_at, occurred_at FROM items ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'c1',
        provider: 'youtube',
        kind: 'comment',
        container_key: 'v',
        container_title: 'Video title',
        author: 'Ann',
        is_own: 0,
        state: 'inbox',
        state_source: 'sync',
        snoozed_until: null,
        woke_at: null,
        occurred_at: '2024-01-01',
      },
      {
        id: 'c2',
        provider: 'youtube',
        kind: 'comment',
        container_key: 'v',
        container_title: 'Video title',
        author: 'Bob',
        is_own: 0,
        state: 'done',
        state_source: 'user',
        snoozed_until: null,
        woke_at: null,
        occurred_at: '2024-01-02',
      },
      {
        id: 'c3',
        provider: 'youtube',
        kind: 'comment',
        container_key: 'v',
        container_title: 'Video title',
        author: 'Cy',
        is_own: 0,
        state: 'inbox',
        state_source: 'sync',
        snoozed_until: '2999-01-01',
        woke_at: null,
        occurred_at: '2024-01-03',
      },
      {
        id: 'c4',
        provider: 'youtube',
        kind: 'comment',
        container_key: 'v',
        container_title: 'Video title',
        author: 'Me',
        is_own: 1,
        state: 'own',
        state_source: 'sync',
        snoozed_until: null,
        woke_at: '2024-02-01',
        occurred_at: '2024-01-04',
      },
    ]);
    // Migration 015 later drops the label tables: they are gone from a fully migrated database.
    expect(tableNames(db)).not.toContain('item_labels');
    expect(db.prepare('SELECT item_id, body, status FROM drafts').all()).toEqual([
      { item_id: 'c2', body: 'draft body', status: 'draft' },
    ]);
    const hits = (q: string) =>
      db.prepare('SELECT id FROM items WHERE rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)').all(q);
    expect(hits('hello')).toEqual([{ id: 'c1' }]);
    expect(hits('Bob')).toEqual([{ id: 'c2' }]);
    // The YouTube detail rows survive untouched, minus the columns that moved to items.
    expect(db.prepare('SELECT id, text_plain, is_own FROM comments ORDER BY id').all()).toHaveLength(4);
    expect(() => db.prepare('SELECT state FROM comments').all()).toThrow(/no such column/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('deleting a comment (or its whole thread) removes its item, draft and search entry', () => {
    const db = v6();
    migrate(db);
    db.prepare("DELETE FROM comments WHERE id = 'c1'").run();
    expect(db.prepare("SELECT 1 FROM items WHERE id = 'c1'").get()).toBeUndefined();
    db.prepare("DELETE FROM threads WHERE id = 't'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM drafts').get()).toEqual({ n: 0 });
    const hits = db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH 'hello'").all();
    expect(hits).toEqual([]);
  });

  it('rejects an unknown state on items', () => {
    const db = v6();
    migrate(db);
    expect(() => db.prepare("UPDATE items SET state = 'bogus' WHERE id = 'c1'").run()).toThrow();
  });
});

describe('older code meeting a newer database', () => {
  it('refuses to start instead of silently reading a schema it does not understand', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer|only understands/);
  });
});

describe('migration 010 (usage_daily)', () => {
  it('adds the counters table to a v9 database without touching existing rows', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS.slice(0, 9).join('\n'));
    db.pragma('user_version = 9');
    db.prepare("INSERT INTO videos (id, title) VALUES ('v', 'T')").run();
    db.prepare(
      "INSERT INTO item_events (item_id, at, kind, source) VALUES ('i', '2026-01-01T00:00:00.000Z', 'state', 'user')",
    ).run();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_daily'").get()).toBeUndefined();

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT title FROM videos').get()).toEqual({ title: 'T' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM item_events').get()).toEqual({ n: 1 });
    db.prepare("INSERT INTO usage_daily (day, key, count) VALUES ('2026-11-11', 'done.kbd', 1)").run();
    // One row per day and key.
    expect(() =>
      db.prepare("INSERT INTO usage_daily (day, key, count) VALUES ('2026-11-11', 'done.kbd', 1)").run(),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO usage_daily (day, key, count) VALUES ('2026-11-11', 'x', NULL)").run(),
    ).toThrow();
  });
});

describe('migration 011 (suggestions)', () => {
  it('adds the suggestions table to a v10 database without touching existing rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS.slice(0, 10).join('\n'));
    db.pragma('user_version = 10');
    db.prepare("INSERT INTO videos (id, title) VALUES ('v', 'T')").run();
    db.prepare(
      `INSERT INTO items (id, provider, kind, occurred_at, state, state_source, state_changed_at, first_seen_at)
       VALUES ('i', 'github', 'pr', 't', 'inbox', 'sync', 't', 't')`,
    ).run();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'suggestions'").get()).toBeUndefined();

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT title FROM videos').get()).toEqual({ title: 'T' });
    const ins = (verdict: string, conf = 'high') =>
      db
        .prepare(
          `INSERT INTO suggestions (item_id, state_key, verdict, category, confidence, reason, model, prompt_version, created_at)
           VALUES ('i', 'k', ?, 'other', ?, 'because', 'm', 'p', 't')`,
        )
        .run(verdict, conf);
    ins('needs_reply');
    expect(db.prepare('SELECT injection_attempt, cost_usd, input_tokens FROM suggestions').get()).toEqual({
      injection_attempt: 0,
      cost_usd: 0,
      input_tokens: 0,
    });
    // One current row per item; unknown verdicts and confidences are refused.
    expect(() => ins('needs_reply')).toThrow();
    expect(() => ins('bogus')).toThrow();
    db.prepare('DELETE FROM suggestions').run();
    expect(() => ins('spam', 'certain')).toThrow();
    // A suggestion goes with its item.
    ins('spam');
    db.prepare("DELETE FROM items WHERE id = 'i'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM suggestions').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('migration 012 (thread-aware suggestions, snooze why, notes)', () => {
  function v11(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS.slice(0, 11).join('\n'));
    db.pragma('user_version = 11');
    db.prepare(
      `INSERT INTO items (id, provider, kind, occurred_at, state, state_source, state_changed_at, first_seen_at)
       VALUES ('i', 'github', 'pr', 't', 'inbox', 'sync', 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO suggestions (item_id, state_key, verdict, category, confidence, reason, model, prompt_version, created_at)
       VALUES ('i', 'k', 'needs_reply', 'other', 'high', 'because', 'm', 'p0-7', 't')`,
    ).run();
    return db;
  }

  it('keeps existing suggestions and items, with the new columns empty', () => {
    const db = v11();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT reason, turn, next_step, thread, thread_count FROM suggestions').get()).toEqual({
      reason: 'because',
      turn: null,
      next_step: null,
      thread: null,
      thread_count: null,
    });
    expect(db.prepare('SELECT snooze_why FROM items').get()).toEqual({ snooze_why: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('adds a notes table that refuses bad scopes and sources and outlives its item', () => {
    const db = v11();
    migrate(db);
    const ins = (scope: string, source = 'text') =>
      db
        .prepare(
          `INSERT INTO notes (created_at, updated_at, text, original_text, scope, source, item_id)
           VALUES ('t', 't', 'x', 'x', ?, ?, 'i')`,
        )
        .run(scope, source);
    ins('standing');
    expect(() => ins('global')).toThrow();
    expect(() => ins('item', 'telepathy')).toThrow();
    expect(db.prepare('SELECT enabled FROM notes').get()).toEqual({ enabled: 1 });
    db.prepare("DELETE FROM items WHERE id = 'i'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 });
  });
});

describe('migration 013 (mute_rules owner kind)', () => {
  it('rebuilds the table to allow owner, keeping rule ids, values and uniqueness', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS.slice(0, 12).join('\n'));
    db.pragma('user_version = 12');
    db.prepare("INSERT INTO mute_rules (id, kind, value, created_at) VALUES (7, 'repo', 'org/app', 't1')").run();
    db.prepare("INSERT INTO mute_rules (id, kind, value, created_at) VALUES (9, 'bots', '', 't2')").run();
    expect(() =>
      db.prepare("INSERT INTO mute_rules (kind, value, created_at) VALUES ('owner', 'org', 't')").run(),
    ).toThrow();

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT id, kind, value, created_at FROM mute_rules ORDER BY id').all()).toEqual([
      { id: 7, kind: 'repo', value: 'org/app', created_at: 't1' },
      { id: 9, kind: 'bots', value: '', created_at: 't2' },
    ]);
    db.prepare("INSERT INTO mute_rules (kind, value, created_at) VALUES ('owner', 'org', 't')").run();
    expect(() =>
      db.prepare("INSERT INTO mute_rules (kind, value, created_at) VALUES ('owner', 'org', 't')").run(),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO mute_rules (kind, value, created_at) VALUES ('nonsense', 'x', 't')").run(),
    ).toThrow();
    // The id sequence carries on past the highest existing id.
    expect((db.prepare("SELECT id FROM mute_rules WHERE kind = 'owner'").get() as { id: number }).id).toBeGreaterThan(
      9,
    );
  });
});

describe('migration 015 (drop user-defined labels)', () => {
  /** A v14 database with labels applied to items and label events in the history, built by the real earlier migrations. */
  function v14() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS.slice(0, 14).join('\n'));
    db.pragma('user_version = 14');
    const add = db.prepare(
      `INSERT INTO items (id, provider, kind, author, state, state_source, state_changed_at, first_seen_at, occurred_at, data)
       VALUES (?, 'github', 'pr', 'ann', 'inbox', 'sync', 'x', 'x', '2024-01-01', ?)`,
    );
    add.run('i1', JSON.stringify({ labels: ['bug'] }));
    add.run('i2', '{}');
    db.prepare(
      "INSERT INTO labels (id, name, color, position, created_at) VALUES (1, 'Q', 'red', 1, 'n'), (2, 'F', 'blue', 2, 'n')",
    ).run();
    db.prepare("INSERT INTO item_labels VALUES ('i1', 1), ('i1', 2), ('i2', 2)").run();
    db.prepare(
      "INSERT INTO item_events (item_id, at, kind, to_value, source) VALUES ('i1', 't1', 'label_add', 'Q', 'user'), ('i1', 't2', 'label_remove', 'F', 'user')",
    ).run();
    return db;
  }

  it('drops both label tables and their index, leaving items and GitHub labels alone', () => {
    const db = v14();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(tableNames(db)).not.toContain('labels');
    expect(tableNames(db)).not.toContain('item_labels');
    const refs = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE '%label%' OR sql LIKE '%item_labels%' OR sql LIKE '% labels%'",
      )
      .all();
    expect(refs).toEqual([]);
    expect(db.prepare('SELECT id, state, data FROM items ORDER BY id').all()).toEqual([
      { id: 'i1', state: 'inbox', data: '{"labels":["bug"]}' },
      { id: 'i2', state: 'inbox', data: '{}' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('keeps label_add and label_remove history rows', () => {
    const db = v14();
    migrate(db);
    expect(db.prepare('SELECT kind, to_value FROM item_events ORDER BY id').all()).toEqual([
      { kind: 'label_add', to_value: 'Q' },
      { kind: 'label_remove', to_value: 'F' },
    ]);
  });

  it('works on a database that never had a label', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS.slice(0, 14).join('\n'));
    db.pragma('user_version = 14');
    migrate(db);
    expect(tableNames(db)).not.toContain('labels');
  });
});

describe("migration 018 (the owner's turn is 'me')", () => {
  /** A database at schema 17 with rows as the code before this migration wrote them. */
  function v17(db = new Database(':memory:')): Database.Database {
    db.exec(MIGRATIONS.slice(0, 17).join('\n'));
    db.pragma('user_version = 17');
    const item = db.prepare(
      `INSERT INTO items (id, provider, kind, occurred_at, state, state_source, state_changed_at, first_seen_at)
       VALUES (?, 'github', 'pr', 't', 'inbox', 'sync', 't', 't')`,
    );
    const sug = db.prepare(
      `INSERT INTO suggestions (item_id, state_key, verdict, category, confidence, reason, model, prompt_version,
         created_at, turn, next_step, thread, thread_count) VALUES (?, 'k', 'needs_reply', 'other', 'high', 'r', 'm',
         'p0-10', 't', ?, NULL, ?, ?)`,
    );
    const thread = JSON.stringify([
      { author: 'dave', isMatt: false, text: 'Here is a fix' },
      { author: 'me', isMatt: true, text: 'Thanks' },
    ]);
    for (const [id, turn, th] of [
      ['a', 'matt', thread],
      ['b', 'them', null],
      ['c', null, '[]'],
      ['d', 'nobody', 'not json'],
      ['e', 'matt', '[{"author":"x","isMatt":true,"text":"y","extra":1},"odd",2]'],
    ] as const) {
      item.run(id);
      sug.run(id, turn, th, th ? 2 : null);
    }
    const ev = db.prepare(
      "INSERT INTO item_events (item_id, at, kind, to_value, source, meta) VALUES ('a', 't', 'state', 'done', 'user', ?)",
    );
    for (const meta of [
      '{"suggested":"reply","suggestedConfidence":"high","suggestedTurn":"matt","reason":"done"}',
      '{"suggested":"skip","suggestedTurn":"them"}',
      '{"suggested":"act"}',
      '{"why":"matt said so","suggestedTurn":"nobody"}',
      'not json',
      '["suggestedTurn","matt"]',
      null,
    ])
      ev.run(meta);
    const note = db.prepare(
      `INSERT INTO notes (created_at, updated_at, text, original_text, scope, source, item_id, suggestion)
       VALUES ('t', 't', 'x', 'x', 'item', 'text', 'a', ?)`,
    );
    for (const s of [
      '{"verdict":"needs_reply","action":"reply","turn":"matt","nextStep":"Merge","reason":"r","confidence":"high"}',
      '{"verdict":"spam","action":"spam","turn":null,"nextStep":null,"reason":"r","confidence":"low"}',
      'garbage',
      null,
    ])
      note.run(s);
    return db;
  }
  const col = (db: Database.Database, sql: string) =>
    (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r)[0]);

  it("renames the stored turn 'matt' to 'me' in suggestions, history events and notes, leaving the rest alone", () => {
    const db = v17();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(col(db, 'SELECT turn FROM suggestions ORDER BY item_id')).toEqual(['me', 'them', null, 'nobody', 'me']);
    const metas = col(db, 'SELECT meta FROM item_events ORDER BY id') as (string | null)[];
    expect(JSON.parse(metas[0]!)).toEqual({
      suggested: 'reply',
      suggestedConfidence: 'high',
      suggestedTurn: 'me',
      reason: 'done',
    });
    expect(metas.slice(1)).toEqual([
      '{"suggested":"skip","suggestedTurn":"them"}',
      '{"suggested":"act"}',
      '{"why":"matt said so","suggestedTurn":"nobody"}',
      'not json',
      '["suggestedTurn","matt"]',
      null,
    ]);
    const notes = col(db, 'SELECT suggestion FROM notes ORDER BY id') as (string | null)[];
    expect(JSON.parse(notes[0]!)).toMatchObject({ turn: 'me', nextStep: 'Merge', action: 'reply' });
    expect(notes.slice(1)).toEqual([
      '{"verdict":"spam","action":"spam","turn":null,"nextStep":null,"reason":"r","confidence":"low"}',
      'garbage',
      null,
    ]);
    expect(col(db, "SELECT COUNT(*) FROM suggestions WHERE turn = 'matt'")).toEqual([0]);
  });

  it('renames isMatt to isOwner in the stored thread excerpts, keeping order, values and anything else', () => {
    const db = v17();
    migrate(db);
    const threads = col(db, 'SELECT thread FROM suggestions ORDER BY item_id') as (string | null)[];
    expect(JSON.parse(threads[0]!)).toEqual([
      { author: 'dave', isOwner: false, text: 'Here is a fix' },
      { author: 'me', isOwner: true, text: 'Thanks' },
    ]);
    expect(threads[1]).toBeNull();
    expect(threads[2]).toBe('[]');
    expect(threads[3]).toBe('not json');
    expect(JSON.parse(threads[4]!)).toEqual([{ author: 'x', isOwner: true, text: 'y', extra: 1 }, 'odd', 2]);
    expect(threads.join('')).not.toContain('isMatt');
  });

  it('is read back by the current code under the new names, with no alias for the old one', () => {
    const db = v17();
    migrate(db);
    const repo = createRepo(db);
    expect(repo.suggestions.get(['a', 'b']).get('a')).toMatchObject({ turn: 'me' });
    expect(
      repo
        .listInbox({ view: 'inbox', suggestion: 'me' })
        .items.map((i) => i.item.id)
        .sort(),
    ).toEqual(['a', 'e']);
    // A row written as 'matt' after the migration (by nothing in the code) is not taken as the owner's turn.
    db.prepare("UPDATE suggestions SET turn = 'matt' WHERE item_id = 'e'").run();
    expect(repo.suggestions.get(['e']).get('e')).toMatchObject({ turn: null });
  });

  it('upgrades a database file only after keeping a copy of it at schema 17', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-mig18-'));
    try {
      const path = join(dir, 'nudge.db');
      v17(new Database(path)).close();
      openDb(path).close();
      const [copy] = readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('pre-migrate-v17-'));
      expect(copy).toBeDefined();
      const old = new Database(join(dir, 'backups', copy!), { readonly: true });
      expect(old.pragma('user_version', { simple: true })).toBe(17);
      expect(col(old, "SELECT turn FROM suggestions WHERE item_id = 'a'")).toEqual(['matt']);
      old.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
