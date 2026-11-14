import type { Db } from './db.js';
import { USAGE_FEATURES, featureOf, isUsageKey, type UsageDTO } from '../../shared/usage.js';

/**
 * Feature-use counters (table usage_daily). Days are UTC dates (YYYY-MM-DD) so a day means the same thing whatever
 * the server's time zone; the cost of that is that a late-evening session in the Americas lands on "tomorrow".
 */
export interface UsageStore {
  /** Add to today's counters. Keys outside the allow-list are skipped and returned, never stored. */
  add(counts: Record<string, number>): { stored: number; skipped: string[] };
  /** Today's value of one counter (0 when there is none). */
  today(key: string): number;
  /** Counters and event-log counts for the last `days` days including today, plus features never used. */
  report(days: number): UsageDTO;
  /** Delete every usage counter. The event log is not touched. */
  reset(): number;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export function createUsage(db: Db, clock: () => Date = () => new Date()): UsageStore {
  // Prepared lazily: tests build repos around databases that are not at the latest version yet.
  function add(counts: Record<string, number>) {
    const day = dayOf(clock());
    const up = db.prepare(
      `INSERT INTO usage_daily (day, key, count) VALUES (?, ?, ?)
       ON CONFLICT(day, key) DO UPDATE SET count = count + excluded.count`,
    );
    const skipped: string[] = [];
    let stored = 0;
    db.transaction(() => {
      for (const [k, n] of Object.entries(counts)) {
        if (!isUsageKey(k) || !Number.isInteger(n) || n < 1) {
          skipped.push(k);
          continue;
        }
        up.run(day, k, n);
        stored++;
      }
    })();
    return { stored, skipped };
  }

  function report(days: number): UsageDTO {
    const to = dayOf(clock());
    const start = new Date(clock());
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const from = dayOf(start);
    const rows = db
      .prepare('SELECT day, key, count FROM usage_daily WHERE day >= ? AND day <= ? ORDER BY day, key')
      .all(from, to) as UsageDTO['rows'];
    // decision/open rows are context about a change, not changes, so counting them would double the numbers.
    // Computed here from the event log rather than copied into usage_daily, so the two can never disagree.
    const events = db
      .prepare(
        `SELECT substr(at, 1, 10) AS day, kind, source, COUNT(*) AS count FROM item_events
          WHERE at >= ? AND at < ? AND kind NOT IN ('decision', 'open') GROUP BY day, kind, source ORDER BY day, kind, source`,
      )
      .all(`${from}T00:00:00.000Z`, nextDay(to)) as UsageDTO['events'];
    const used = new Set(rows.filter((r) => r.count > 0).map((r) => featureOf(r.key)));
    return { days, from, to, rows, events, unused: USAGE_FEATURES.filter((f) => !used.has(f)) };
  }

  function today(key: string): number {
    const r = db.prepare('SELECT count FROM usage_daily WHERE day = ? AND key = ?').get(dayOf(clock()), key) as
      { count: number } | undefined;
    return r?.count ?? 0;
  }

  function reset(): number {
    return db.prepare('DELETE FROM usage_daily').run().changes;
  }

  return { add, today, report, reset };
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
