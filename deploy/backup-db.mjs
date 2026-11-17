// Runs inside the container: node deploy/backup-db.mjs <dest.db>
// Uses SQLite's online backup API, so it is safe while the app is writing, then verifies the copy.
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const dest = process.argv[2];
if (!dest) {
  console.error('usage: backup-db.mjs <dest.db>');
  process.exit(2);
}
// YOUTUBEY_DB is the legacy name from before the rename, kept only as a fallback for old setups.
const src = process.env.NUDGE_DB || process.env.YOUTUBEY_DB || 'data/nudge.db';
// The copy holds every token and key: the directory, the copy and SQLite's journal beside it are owner-only from
// creation, not world-readable until the chmod below.
process.umask(0o077);
mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });

const live = new Database(src, { readonly: true, fileMustExist: true });
try {
  await live.backup(dest);
} finally {
  live.close();
}
// Convert the copy to a rollback-journal file so it is one self-contained .db (no -wal/-shm sidecars to lose or leak).
const copy = new Database(dest);
try {
  copy.pragma('journal_mode = delete');
  const check = copy.pragma('integrity_check', { simple: true });
  const comments = copy.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
  if (check !== 'ok') throw new Error(`integrity_check: ${check}`);
  chmodSync(dest, 0o600);
  console.log(`ok ${dest} comments=${comments}`);
} catch (e) {
  rmSync(dest, { force: true });
  console.error(`backup verification failed: ${e.message}`);
  process.exit(1);
} finally {
  copy.close();
  for (const ext of ['-wal', '-shm']) rmSync(dest + ext, { force: true });
}
