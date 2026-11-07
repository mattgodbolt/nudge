import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { devOrigins } from './app.js';
import { migrate, openDb } from './db/db.js';
import { MIGRATIONS } from './db/migrations.js';
import { createRepo } from './db/repo.js';
import { nonDemoSources } from './demo/seed.js';
import { DEMO_OWN_CHANNEL_ID } from './demo/world.js';

describe('hardening', () => {
  it('trusts the Vite dev origins only outside production', () => {
    expect(devOrigins({ NODE_ENV: 'production' })).toEqual([]);
    expect(devOrigins({}).length).toBeGreaterThan(0);
    expect(devOrigins({ NODE_ENV: 'development' })).toContain('http://localhost:5173');
  });

  it('creates the database file owner-only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yt-perm-')), 'db', 'y.db');
    openDb(path).close();
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('upgrades a v1 database in place, keeping its rows', () => {
    const db = new Database(':memory:');
    db.exec(MIGRATIONS[0]!);
    db.pragma('user_version = 1');
    db.prepare("INSERT INTO videos (id, title) VALUES ('v', 'T')").run();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT scan_incomplete FROM videos').get()).toEqual({ scan_incomplete: 0 });
  });

  it('detects non-demo sources so demo mode never touches a real database', () => {
    const repo = createRepo(openDb(':memory:'));
    expect(nonDemoSources(repo)).toEqual([]);
    repo.addSource({
      kind: 'channel',
      ytId: DEMO_OWN_CHANNEL_ID,
      title: 'd',
      thumbnailUrl: null,
      isOwn: true,
      importMode: 'recent',
    });
    expect(nonDemoSources(repo)).toEqual([]);
    repo.addSource({
      kind: 'video',
      ytId: 'realVideo001',
      title: 'Mine',
      thumbnailUrl: null,
      isOwn: false,
      importMode: 'recent',
    });
    expect(nonDemoSources(repo)).toEqual(['Mine']);
  });
});
