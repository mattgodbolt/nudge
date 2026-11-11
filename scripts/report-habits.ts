// Print how the owner triages, from the item_events history. Counts and durations only, never item text:
//
//   npm run report:habits -- <db>
//
// Read-only: the database is opened read-only (point it at a copy of a backup, not the live file) and nothing is
// migrated. A database from before migration 9 has no item_events table and reports that instead of failing.
import Database from 'better-sqlite3';
import { formatHabits, habitsReport } from '../server/db/habits.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: report-habits.ts <db>');
  process.exit(2);
}
const db = new Database(path, { readonly: true, fileMustExist: true });
try {
  console.log(formatHabits(habitsReport(db)));
} catch (e) {
  if (e instanceof Error && /no such table/i.test(e.message)) {
    console.log('No event history in this database (it predates the item_events table). Nothing to report.');
  } else throw e;
}
