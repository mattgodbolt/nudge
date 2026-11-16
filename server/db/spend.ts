import type { Db } from './db.js';

export type SpendPurpose = 'suggest' | 'snooze_ai' | 'assistant';

/**
 * The daily model-spend ledger (table llm_spend) behind the cost cap. Every model call adds its estimate here, whatever
 * it was for, and nothing removes it: replacing a suggestion, deleting an item or "Reset usage data" (usage_daily, which
 * keeps its own copies of the assistant and snooze costs for the usage page) leaves it alone. Days are UTC.
 */
export interface SpendStore {
  /** Add an estimated cost, in micro-dollars, to today's figure. Zero, negative and non-finite amounts are ignored. */
  add(purpose: SpendPurpose, micros: number): void;
  /** Dollars spent today on every purpose together. */
  todayUsd(): number;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export function createSpend(db: Db, clock: () => Date = () => new Date()): SpendStore {
  // Prepared on use, like the usage store: some tests build a repo around a database not yet at the latest version.
  return {
    add(purpose, micros) {
      if (!Number.isFinite(micros) || micros <= 0) return;
      // Round up: a fraction of a micro-dollar is still spend, and the cap should err towards stopping.
      db.prepare(
        `INSERT INTO llm_spend (day, purpose, micros) VALUES (?, ?, ?)
         ON CONFLICT(day, purpose) DO UPDATE SET micros = micros + excluded.micros`,
      ).run(dayOf(clock()), purpose, Math.ceil(micros));
    },
    todayUsd() {
      const r = db.prepare('SELECT COALESCE(SUM(micros), 0) AS m FROM llm_spend WHERE day = ?').get(dayOf(clock()));
      return (r as { m: number }).m / 1e6;
    },
  };
}
