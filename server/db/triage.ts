import type { CommentState, DoneReason, TriageResult } from '../../shared/types.js';
import type { Repo } from '../contracts.js';
import { loadUndoable, type Row } from './common.js';
import type { Db } from './db.js';
import type { Events } from './events.js';

export type TriageStore = Pick<Repo, 'triage' | 'undo'>;

/**
 * One item's entry in triage_actions.changes. Rows written before snoozes were kept have neither `snooze` nor
 * `keptState`, and every entry of theirs is a state change.
 */
interface StoredTriage {
  commentId: string;
  from: CommentState;
  fromSource?: string;
  fromReason?: string | null;
  /** The snooze a move back to the inbox cleared (only the fields that move clears). */
  snooze?: { until: string; untilActivity: boolean; snoozedAt: string | null };
  /** Set when only the snooze changed: the item was already in the inbox. */
  keptState?: true;
}

export interface TriageDeps {
  db: Db;
  clock: () => Date;
  now: () => string;
  events: Events;
  /** The sidebar counts every result carries. */
  counts: Repo['counts'];
}

/** Moving items between states by hand, and undoing such a move. */
export function createTriage(deps: TriageDeps): TriageStore {
  const { db, clock, now, events, counts } = deps;

  function triage(ids: string[], to: CommentState, reason: DoneReason | null = null): TriageResult {
    // A reason only qualifies 'done'; any other target clears it.
    const newReason = to === 'done' ? reason : null;
    return db.transaction(() => {
      const at = now();
      const get = db.prepare(
        `SELECT state, state_source, done_reason, snoozed_until, snooze_until_activity, snoozed_at
           FROM items WHERE id = ?`,
      );
      const set = db.prepare(
        "UPDATE items SET state = ?, state_source = 'user', state_changed_at = ?, done_reason = ? WHERE id = ?",
      );
      const changes: { commentId: string; from: CommentState; to: CommentState }[] = [];
      const stored: StoredTriage[] = [];
      const woken: { id: string; from: string }[] = [];
      // Moving something back to the inbox must show it, so it also loses any snooze (even if already in 'inbox').
      const unsnooze = db.prepare(
        'UPDATE items SET snoozed_until = NULL, snooze_until_activity = 0 WHERE id = ? AND snoozed_until IS NOT NULL',
      );
      for (const id of new Set(ids)) {
        const r = get.get(id) as Row | undefined;
        if (!r || r.state === 'own') continue;
        // Kept so undo can put the snooze back, even on an item whose state this does not change.
        let snooze: StoredTriage['snooze'];
        if (to === 'inbox' && unsnooze.run(id).changes > 0) {
          woken.push({ id, from: r.snoozed_until });
          snooze = {
            until: r.snoozed_until,
            untilActivity: r.snooze_until_activity === 1,
            snoozedAt: r.snoozed_at ?? null,
          };
        }
        // Done to dismissed (or back) is a change even though the state is the same: the record must follow.
        const current = r.state === 'done' ? (r.done_reason ?? null) : null;
        const entry: StoredTriage = {
          commentId: id,
          from: r.state,
          fromSource: r.state_source,
          fromReason: current,
          ...(snooze ? { snooze } : {}),
        };
        if (r.state === to && current === newReason) {
          if (snooze) stored.push({ ...entry, keptState: true });
          continue;
        }
        set.run(to, at, newReason, id);
        changes.push({ commentId: id, from: r.state, to });
        stored.push(entry);
      }
      const res = db
        .prepare('INSERT INTO triage_actions (created_at, to_state, changes) VALUES (?, ?, ?)')
        .run(at, to, JSON.stringify(stored));
      const actionId = Number(res.lastInsertRowid);
      for (const c of changes) {
        events.record({
          itemId: c.commentId,
          at,
          kind: 'state',
          from: c.from,
          to: c.to,
          source: 'user',
          // Every done the app records from here on names its reason, so a bare done in the log is known to predate
          // dismissals (the habits report treats those as ambiguous).
          meta: { actionId, ...(to === 'done' ? { reason: newReason ?? 'done' } : {}) },
        });
      }
      for (const w of woken) {
        events.record({
          itemId: w.id,
          at,
          kind: 'snooze',
          from: w.from,
          to: null,
          source: 'user',
          meta: { actionId, via: 'triage', cause: 'manual' },
        });
      }
      return { actionId, changes, counts: counts() };
    })();
  }

  function undo(actionId: number): TriageResult {
    return db.transaction(() => {
      const a = loadUndoable(db, clock, actionId, false);
      const at = now();
      const stored = JSON.parse(a.changes) as StoredTriage[];
      const restore = db.prepare(
        `UPDATE items SET state = ?, state_source = ?, state_changed_at = ?, done_reason = ? WHERE id = ? AND state = ?`,
      );
      // Only where nothing has snoozed the item since: still unsnoozed, and no later snooze (even one undone or
      // unsnoozed again, which leaves its own start behind). A snooze whose time has passed meanwhile goes back as it
      // was, already ended, so the waker sweeps it as if the move had never happened (with its audit nag, if any).
      const resnooze = db.prepare(
        `UPDATE items SET snoozed_until = @until, snooze_until_activity = @ua
           WHERE id = @id AND state = @state AND snoozed_until IS NULL AND snoozed_at IS @sat`,
      );
      const changes: TriageResult['changes'] = [];
      for (const c of stored) {
        // Where the state went back, or was never moved; a state the owner has changed since keeps its snooze off too.
        let state: string | null = a.to_state;
        if (!c.keptState) {
          const res = restore.run(c.from, c.fromSource ?? 'user', at, c.fromReason ?? null, c.commentId, a.to_state);
          state = res.changes ? c.from : null;
          if (res.changes) {
            changes.push({ commentId: c.commentId, from: a.to_state, to: c.from });
            events.record({
              itemId: c.commentId,
              at,
              kind: 'undo',
              from: a.to_state,
              to: c.from,
              source: 'user',
              meta: {
                actionId,
                original: 'state',
                originalEventId: events.originalEventId(c.commentId, actionId, 'state'),
              },
            });
          }
        }
        if (!c.snooze || state === null) continue;
        const res = resnooze.run({
          until: c.snooze.until,
          ua: c.snooze.untilActivity ? 1 : 0,
          id: c.commentId,
          state,
          sat: c.snooze.snoozedAt,
        });
        if (res.changes) {
          events.record({
            itemId: c.commentId,
            at,
            kind: 'undo',
            from: null,
            to: c.snooze.until,
            source: 'user',
            meta: {
              actionId,
              original: 'snooze',
              originalEventId: events.originalEventId(c.commentId, actionId, 'snooze'),
            },
          });
        }
      }
      db.prepare('UPDATE triage_actions SET undone_at = ? WHERE id = ?').run(at, actionId);
      return { actionId, changes, counts: counts() };
    })();
  }

  return { triage, undo };
}
