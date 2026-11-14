import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A todo is an item like any other (provider 'todo'), so triage, snooze, search and undo all just work. */
export function createTodosRepo(deps: { db: Database; now: () => string }) {
  const { db, now } = deps;

  /** A due time in the future is a snooze: the todo stays out of the inbox until then, and the waker nudges. */
  const snoozeFor = (dueAt: string | null, at: string): string | null =>
    dueAt && new Date(dueAt).toISOString() > at ? new Date(dueAt).toISOString() : null;

  function addTodo(input: { title: string; notes: string; raw: string; dueAt: string | null }): string {
    const id = `todo:${randomUUID()}`;
    const at = now();
    db.prepare(
      `INSERT INTO items (id, provider, kind, container_key, container_title, title, is_own, body_plain, occurred_at,
         reason, data, state, state_source, state_changed_at, snoozed_until, first_seen_at)
       VALUES (?, 'todo', 'todo', 'todo', 'Todo', ?, 0, ?, ?, 'new', ?, 'inbox', 'user', ?, ?, ?)`,
    ).run(id, input.title, input.notes, at, JSON.stringify({ raw: input.raw }), at, snoozeFor(input.dueAt, at), at);
    return id;
  }

  function deleteTodo(id: string): boolean {
    return db.prepare("DELETE FROM items WHERE id = ? AND provider = 'todo'").run(id).changes > 0;
  }

  return { addTodo, deleteTodo };
}
