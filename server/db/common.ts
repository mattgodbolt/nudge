/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Db } from './db.js';

/** A row as better-sqlite3 returns it; the stores map these to DTOs by hand. */
export type Row = Record<string, any>;

/** Normalise any ISO-ish timestamp so string comparison in SQL is chronological. */
export function iso(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export type UndoErrorCode = 'not_found' | 'already_undone' | 'expired';
export class UndoError extends Error {
  constructor(
    public code: UndoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UndoError';
  }
}

/** Fetch an undoable action row; snooze actions (to_state 'snoozed') and triage actions never cross over. */
export function loadUndoable(db: Db, clock: () => Date, actionId: number, snooze: boolean): Row {
  const a = db.prepare('SELECT * FROM triage_actions WHERE id = ?').get(actionId) as Row | undefined;
  if (!a || (a.to_state === 'snoozed') !== snooze) throw new UndoError('not_found', `No such action ${actionId}`);
  if (a.undone_at) throw new UndoError('already_undone', `Action ${actionId} was already undone`);
  if (clock().getTime() - new Date(a.created_at).getTime() >= UNDO_WINDOW_MS) {
    throw new UndoError('expired', `Action ${actionId} is older than 24 hours`);
  }
  return a;
}
