// Dump the item_events history as JSONL (one event per line, oldest first) for offline training and evaluation:
//
//   npx tsx scripts/export-events.ts <db> [--since <iso>] > events.jsonl
//
// Read-only: the database is opened read-only (point it at a copy of a backup, not the live file) and nothing is
// migrated, so a database from before migration 9 fails with "no such table" rather than being changed.
import Database from 'better-sqlite3';
import { exportEventsJsonl } from '../server/db/events.js';

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt >= 0 ? args.splice(sinceAt, 2)[1] : undefined;
const path = args[0];
if (!path || (sinceAt >= 0 && !since)) {
  console.error('usage: export-events.ts <db> [--since <iso>]');
  process.exit(2);
}
const db = new Database(path, { readonly: true, fileMustExist: true });
const n = exportEventsJsonl(db, (line) => process.stdout.write(line), since ? { since } : {});
console.error(`${n} events`);
