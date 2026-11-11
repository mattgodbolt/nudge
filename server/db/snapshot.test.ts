import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, snapshotBeforeMigrating } from './db.js';
import { MIGRATIONS } from './migrations.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'nudge-snap-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A database left at an older schema version, with a row to look for in the copy. */
function oldDb(path: string, version: number): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(MIGRATIONS.slice(0, version).join('\n'));
  db.pragma(`user_version = ${version}`);
  db.prepare("INSERT INTO videos (id, title) VALUES ('v', 'precious')").run();
  db.close();
}

const snaps = (dir: string): string[] => readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('pre-migrate-'));

describe('snapshotBeforeMigrating', () => {
  it('copies an existing database at its old schema before upgrading it', () => {
    const dir = tmp();
    oldDb(join(dir, 'nudge.db'), 8);
    const db = openDb(join(dir, 'nudge.db'));
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const [name] = snaps(dir);
    expect(name).toMatch(/^pre-migrate-v8-.*\.db$/);
    const copy = new Database(join(dir, 'backups', name!), { readonly: true });
    expect(copy.pragma('user_version', { simple: true })).toBe(8);
    expect(copy.prepare('SELECT title FROM videos').get()).toEqual({ title: 'precious' });
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'item_events'").get()).toBeUndefined();
    copy.close();
    expect(statSync(join(dir, 'backups', name!)).mode & 0o777).toBe(0o600);
    db.close();
  });

  it('snapshots a v9 database before the usage_daily migration, leaving the copy without that table', () => {
    const dir = tmp();
    oldDb(join(dir, 'nudge.db'), 9);
    const db = openDb(join(dir, 'nudge.db'));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_daily'").get()).toBeTruthy();
    const [name] = snaps(dir);
    expect(name).toMatch(/^pre-migrate-v9-.*\.db$/);
    const copy = new Database(join(dir, 'backups', name!), { readonly: true });
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_daily'").get()).toBeUndefined();
    expect(copy.prepare('SELECT title FROM videos').get()).toEqual({ title: 'precious' });
    copy.close();
    db.close();
  });

  it('takes nothing for a fresh database, an up-to-date one or an in-memory one', () => {
    const dir = tmp();
    openDb(join(dir, 'nudge.db')).close();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    openDb(join(dir, 'nudge.db')).close();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    openDb(':memory:').close();
  });

  it('refuses to migrate, leaving the database untouched, when the snapshot cannot be made', () => {
    const dir = tmp();
    oldDb(join(dir, 'nudge.db'), 8);
    // A file where the backups directory should be: the snapshot cannot be written.
    writeFileSync(join(dir, 'backups'), 'in the way');
    expect(() => openDb(join(dir, 'nudge.db'))).toThrow();
    const raw = new Database(join(dir, 'nudge.db'), { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(8);
    raw.close();
  });

  it('keeps only the newest few snapshots and leaves the nightly backups alone', () => {
    const dir = tmp();
    oldDb(join(dir, 'nudge.db'), 8);
    const db = new Database(join(dir, 'nudge.db'));
    writeFileSync(join(dir, 'unrelated'), '');
    for (let i = 0; i < 8; i++) {
      snapshotBeforeMigrating(db, join(dir, 'nudge.db'), new Date(Date.UTC(2026, 0, 1 + i)));
    }
    writeFileSync(join(dir, 'backups', 'nudge-20260101-000000.db'), 'nightly');
    snapshotBeforeMigrating(db, join(dir, 'nudge.db'), new Date(Date.UTC(2026, 0, 20)));
    const kept = snaps(dir);
    expect(kept).toHaveLength(5);
    expect(kept.some((f) => f.includes('20260101'))).toBe(false);
    expect(kept.some((f) => f.includes('20260120'))).toBe(true);
    expect(existsSync(join(dir, 'backups', 'nudge-20260101-000000.db'))).toBe(true);
    db.close();
  });
});
