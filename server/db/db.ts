import Database from 'better-sqlite3';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const PRE_MIGRATE_KEEP = 5;

/**
 * Before upgrading an existing database, keep a consistent copy of it next to the nightly backups. This is the last
 * line of defence: it protects every way of starting the app (the deploy script, a manual docker run, a rollback by
 * hand), not just the paths that remember to take a backup first. If the copy cannot be made the upgrade is refused:
 * failing to start is recoverable, a migration with no way back may not be. Fresh databases have nothing to protect.
 */
export function snapshotBeforeMigrating(db: Db, path: string, at: Date = new Date()): string | null {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (path === ':memory:' || path === '' || current === 0 || current >= MIGRATIONS.length) return null;
  const dir = join(dirname(path), 'backups');
  // A copy holds every token and key: owner-only from the moment it exists, never world-readable until a chmod.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, `pre-migrate-v${current}-${at.toISOString().replace(/[-:.]/g, '')}.db`);
  try {
    // VACUUM INTO accepts an empty file, so the copy is created owner-only here rather than with SQLite's default mode.
    closeSync(openSync(dest, 'wx', 0o600));
    // VACUUM INTO writes a self-contained, consistent file (no -wal/-shm sidecars) even while the DB is in WAL mode.
    db.prepare('VACUUM INTO ?').run(dest);
    chmodSync(dest, 0o600);
  } catch (e) {
    rmSync(dest, { force: true });
    throw new Error(
      `Refusing to migrate the database from schema v${current}: could not snapshot it first (${e instanceof Error ? e.message : e}).`,
    );
  }
  // Keep the newest few. The nightly backup script only prunes its own nudge-*.db files, so these would pile up.
  const old = readdirSync(dir)
    .filter((f) => /^pre-migrate-v\d+-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(PRE_MIGRATE_KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return dest;
}

export function openDb(path: string): Db {
  if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  snapshotBeforeMigrating(db, path);
  migrate(db);
  if (path !== ':memory:' && path !== '') restrictPermissions(path);
  return db;
}
