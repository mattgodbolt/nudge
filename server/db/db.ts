import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export class SchemaTooNewError extends Error {
  constructor(
    public dbVersion: number,
    public codeVersion: number,
  ) {
    super(
      `The database is at schema version ${dbVersion} but this build only understands up to ${codeVersion}. ` +
        'Refusing to start: running older code against a newer schema can silently read stale data. ' +
        'Restore a backup taken before the upgrade, or run the newer version.',
    );
    this.name = 'SchemaTooNewError';
  }
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) throw new SchemaTooNewError(current, MIGRATIONS.length);
  if (current === MIGRATIONS.length) return;
  // One transaction for the whole upgrade: all-or-nothing, and one commit instead of one per migration, which matters
  // on slow storage (a fresh database runs every migration).
  db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    }
  })();
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
