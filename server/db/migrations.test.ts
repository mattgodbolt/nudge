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
