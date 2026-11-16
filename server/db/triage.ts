import type { CommentState, DoneReason, TriageResult } from '../../shared/types.js';
import type { Repo } from '../contracts.js';
import { loadUndoable, type Row } from './common.js';
import type { Db } from './db.js';
import type { Events } from './events.js';

export type TriageStore = Pick<Repo, 'triage' | 'undo'>;

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
      const get = db.prepare('SELECT state, state_source, done_reason, snoozed_until FROM items WHERE id = ?');
      const set = db.prepare(
        "UPDATE items SET state = ?, state_source = 'user', state_changed_at = ?, done_reason = ? WHERE id = ?",
      );
      const changes: { commentId: string; from: CommentState; to: CommentState }[] = [];
      const stored: { commentId: string; from: CommentState; fromSource: string; fromReason: string | null }[] = [];
      const woken: { id: string; from: string }[] = [];
      // Moving something back to the inbox must show it, so it also loses any snooze (even if already in 'inbox').
      const unsnooze = db.prepare(
        'UPDATE items SET snoozed_until = NULL, snooze_until_activity = 0 WHERE id = ? AND snoozed_until IS NOT NULL',
      );
      for (const id of new Set(ids)) {
        const r = get.get(id) as Row | undefined;
        if (!r || r.state === 'own') continue;
        if (to === 'inbox' && unsnooze.run(id).changes > 0) woken.push({ id, from: r.snoozed_until });
        // Done to dismissed (or back) is a change even though the state is the same: the record must follow.
        const current = r.state === 'done' ? (r.done_reason ?? null) : null;
        if (r.state === to && current === newReason) continue;
        set.run(to, at, newReason, id);
        changes.push({ commentId: id, from: r.state, to });
        stored.push({
          commentId: id,
          from: r.state,
          fromSource: r.state_source,
          fromReason: current,
        });
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
      const stored = JSON.parse(a.changes) as {
        commentId: string;
        from: CommentState;
        fromSource?: string;
        fromReason?: string | null;
      }[];
      const restore = db.prepare(
        `UPDATE items SET state = ?, state_source = ?, state_changed_at = ?, done_reason = ? WHERE id = ? AND state = ?`,
      );
      const changes: TriageResult['changes'] = [];
      for (const c of stored) {
        const res = restore.run(c.from, c.fromSource ?? 'user', at, c.fromReason ?? null, c.commentId, a.to_state);
        if (res.changes) {
          changes.push({ commentId: c.commentId, from: a.to_state, to: c.from });
          events.record({
            itemId: c.commentId,
            at,
            kind: 'undo',
            from: a.to_state,
            to: c.from,
            source: 'user',
            meta: { actionId, original: 'state', originalEventId: events.originalEventId(c.commentId, actionId) },
          });
        }
      }
      db.prepare('UPDATE triage_actions SET undone_at = ? WHERE id = ?').run(at, actionId);
      return { actionId, changes, counts: counts() };
    })();
  }

  return { triage, undo };
}
