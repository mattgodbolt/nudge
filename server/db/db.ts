import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Comments and the API key live in here: owner-only. The WAL/SHM sidecars may not exist yet, so best effort. */
function restrictPermissions(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch {
      /* missing sidecar or unsupported filesystem */
    }
  }
}

export function openDb(path: string): Db {
  if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  if (path !== ':memory:' && path !== '') restrictPermissions(path);
  return db;
}
