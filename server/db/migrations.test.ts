import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from './db.js';
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
    expect(db.prepare('SELECT id, snoozed_until, woke_at FROM comments').get()).toEqual({
      id: 'c1',
      snoozed_until: null,
      woke_at: null,
    });
    expect(
      db
        .prepare(
          "SELECT id FROM comments WHERE rowid IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH 'hello')",
        )
        .all(),
    ).toHaveLength(1);
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO labels (name, color, position, created_at) VALUES ('Q', 'red', 1, 'n')").run();
    db.prepare("INSERT INTO comment_labels VALUES ('c1', 1)").run();
    db.prepare('DELETE FROM labels WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM comment_labels').get()).toEqual({ n: 0 });
  });
});
