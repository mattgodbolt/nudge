import type { SyncRunSummary } from '../../shared/types.js';
import type { Repo } from '../contracts.js';
import type { Row } from './common.js';
import type { Db } from './db.js';

export type QuotaStore = Pick<
  Repo,
  'recordQuota' | 'quotaUsed' | 'quotaByEndpoint' | 'startRun' | 'finishRun' | 'lastRun'
>;

function runSummary(r: Row): SyncRunSummary {
  return {
    id: r.id,
    trigger: r.trigger,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    units: r.units ?? 0,
    videos: r.videos ?? 0,
    newComments: r.new_comments ?? 0,
    error: r.error,
  };
}

/** The YouTube quota ledger and the sync run log. */
export function createQuota(deps: { db: Db; now: () => string }): QuotaStore {
  const { db, now } = deps;
  return {
    recordQuota(dayPt, endpoint, units) {
      db.prepare(
        `INSERT INTO quota_ledger (day_pt, endpoint, units, calls) VALUES (?, ?, ?, 1)
         ON CONFLICT(day_pt, endpoint) DO UPDATE SET units = units + excluded.units, calls = calls + 1`,
      ).run(dayPt, endpoint, units);
    },
    quotaUsed: (dayPt) =>
      (db.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM quota_ledger WHERE day_pt = ?').get(dayPt) as Row).n,
    quotaByEndpoint: (dayPt) =>
      db.prepare('SELECT endpoint, units, calls FROM quota_ledger WHERE day_pt = ? ORDER BY endpoint').all(dayPt) as {
        endpoint: string;
        units: number;
        calls: number;
      }[],
    startRun: (trigger, scope) =>
      Number(
        db.prepare('INSERT INTO sync_runs (trigger, scope, started_at) VALUES (?, ?, ?)').run(trigger, scope, now())
          .lastInsertRowid,
      ),
    finishRun(id, p) {
      db.prepare(
        'UPDATE sync_runs SET finished_at = ?, units = ?, videos = ?, new_comments = ?, error = ? WHERE id = ?',
      ).run(now(), p.units, p.videos, p.newComments, p.error, id);
      return runSummary(db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as Row);
    },
    lastRun() {
      const r = db.prepare('SELECT * FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as
        Row | undefined;
      return r ? runSummary(r) : null;
    },
  };
}
