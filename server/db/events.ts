import type { Statement } from 'better-sqlite3';
import type { Db } from './db.js';

/**
 * Append-only history of what happens to items (table item_events). It exists to become training and evaluation data
 * for a classifier, and history cannot be reconstructed later, so every site that changes an item's state, snooze or
 * labels, or sends a reply, writes one of these in the same transaction as the change.
 *
 * Vocabulary:
 *  - state:        from_value/to_value are item states.
 *  - snooze:       from_value/to_value are the "until" ISO time, null meaning not snoozed (to_value null = unsnooze).
 *  - label_add / label_remove: the label NAME in to_value / from_value (labels get renamed and deleted), id in meta.
 *  - reply:        a reply was sent (YouTube, via the app) or first seen (GitHub, by sync).
 *  - mute/unmute:  a mute rule was added or removed. item_id is the item for `item` rules, '' otherwise (the rule
 *                  covers many items; the ones archived on the spot get their own `state` events from triage).
 *  - undo:         compensates an earlier event (meta.actionId, and meta.originalEventId when it is found). Earlier
 *                  events are never edited or deleted. from_value is what was undone, to_value what was restored.
 *
 * Source says who decided, and matches the state_source the same change writes: `user` is a deliberate action in the
 * UI or API, `auto` a rule the app applied by itself (auto-clear after my reply, snooze wake-ups), `sync` state that
 * came from the remote service (closed or reopened upstream, new comments, ownership changes).
 *
 *  - decision:     what the owner decided about an item, with the context it was decided in (written by the browser via
 *                  POST /api/item-events, in addition to the state/snooze/label rows the action itself writes).
 *                  to_value is the action as the API call carried it ('done', 'replied', 'inbox', 'snooze',
 *                  'unsnooze', 'label'...); from_value is null. meta: { view, rank (0-based position in the list
 *                  on screen, or null), listSize, above (ids of up to 10 items ranked just above that were still
 *                  listed, i.e. passed over), input ('key'|'button'|'palette'|'touch'|'other'), bulk, selectionSize }.
 *  - open:         the owner opened the item's detail. to_value is the view it was opened from; meta: { input,
 *                  dwellMs? } where dwellMs is how long it stayed open (sent on close, dropped under 300 ms).
 *
 * Not recorded, on purpose: an item's initial state when first seen (a bulk import would write thousands of rows;
 * the arrival time is items.first_seen_at and the first event's from_value says what it was), and the cascade when a
 * label or item is deleted.
 */
export type EventKind =
  'state' | 'snooze' | 'label_add' | 'label_remove' | 'reply' | 'mute' | 'unmute' | 'undo' | 'decision' | 'open';
export type EventSource = 'user' | 'auto' | 'sync';

export interface NewItemEvent {
  itemId: string;
  at: string;
  kind: EventKind;
  from?: string | null;
  to?: string | null;
  source: EventSource;
  meta?: Record<string, unknown>;
}

export interface ItemEventRow {
  id: number;
  itemId: string;
  at: string;
  kind: EventKind;
  from: string | null;
  to: string | null;
  source: EventSource;
  meta: Record<string, unknown> | null;
}

export interface Events {
  /** Callers must already be inside the transaction that makes the change, so event and change commit together. */
  record(e: NewItemEvent): void;
  /** Record a state event per item the given UPDATE is about to change; call it just before that UPDATE. */
  recordStateMoves(
    where: string,
    params: unknown[],
    toSql: string,
    source: EventSource,
    at: string,
    meta?: Record<string, unknown>,
  ): void;
  /** The id of the earliest state/snooze event that action wrote for the item, to reference from an undo. */
  originalEventId(itemId: string, actionId: number): number | null;
  /**
   * Merge extra context into the meta of the snooze event an action wrote for an item, after the fact (the context
   * comes from a slow lookup that must not hold up the snooze). Existing keys are kept unless the patch names them.
   * Returns false when there is no such event. Nothing else about the event changes.
   */
  mergeSnoozeMeta(itemId: string, actionId: number, patch: Record<string, unknown>): boolean;
}

export function createEvents(db: Db): Events {
  // Prepared lazily: tests (and migrations) build repos around databases that are not at the latest version yet.
  let insert: Statement | undefined;

  function record(e: NewItemEvent): void {
    insert ??= db.prepare(
      'INSERT INTO item_events (item_id, at, kind, from_value, to_value, source, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(e.itemId, e.at, e.kind, e.from ?? null, e.to ?? null, e.source, e.meta ? JSON.stringify(e.meta) : null);
  }

  function recordStateMoves(
    where: string,
    params: unknown[],
    toSql: string,
    source: EventSource,
    at: string,
    meta?: Record<string, unknown>,
  ): void {
    const rows = db.prepare(`SELECT id, state AS f, ${toSql} AS t FROM items WHERE ${where}`).all(...params) as {
      id: string;
      f: string;
      t: string;
    }[];
    for (const r of rows) {
      if (r.f !== r.t)
        record({ itemId: r.id, at, kind: 'state', from: r.f, to: r.t, source, ...(meta ? { meta } : {}) });
    }
  }

  function originalEventId(itemId: string, actionId: number): number | null {
    const r = db
      .prepare(
        `SELECT id FROM item_events WHERE item_id = ? AND kind IN ('state', 'snooze')
           AND json_extract(meta, '$.actionId') = ? ORDER BY id LIMIT 1`,
      )
      .get(itemId, actionId) as { id: number } | undefined;
    return r?.id ?? null;
  }

  function mergeSnoozeMeta(itemId: string, actionId: number, patch: Record<string, unknown>): boolean {
    const r = db
      .prepare(
        `SELECT id, meta FROM item_events WHERE item_id = ? AND kind = 'snooze' AND source = 'user'
           AND json_extract(meta, '$.actionId') = ? ORDER BY id LIMIT 1`,
      )
      .get(itemId, actionId) as { id: number; meta: string | null } | undefined;
    if (!r) return false;
    let cur: Record<string, unknown> = {};
    try {
      const v = r.meta ? JSON.parse(r.meta) : {};
      if (v && typeof v === 'object' && !Array.isArray(v)) cur = v as Record<string, unknown>;
    } catch {
      // Unreadable meta: the patch replaces it rather than losing the context.
    }
    db.prepare('UPDATE item_events SET meta = ? WHERE id = ?').run(JSON.stringify({ ...cur, ...patch }), r.id);
    return true;
  }

  return { record, recordStateMoves, originalEventId, mergeSnoozeMeta };
}

/** Writes browser-reported events (decision/open). Unlike `Events.record` these are not part of another change. */
export interface ClientEventStore {
  /** Insert the events whose item exists, in one transaction; returns how many were stored and how many were skipped. */
  record(events: NewItemEvent[]): { accepted: number; unknown: number };
}

export function createClientEvents(db: Db): ClientEventStore {
  return {
    record(events) {
      const exists = db.prepare('SELECT 1 FROM items WHERE id = ?');
      const ev = createEvents(db);
      let accepted = 0;
      let unknown = 0;
      db.transaction(() => {
        for (const e of events) {
          if (!exists.get(e.itemId)) {
            unknown++;
            continue;
          }
          ev.record(e);
          accepted++;
        }
      })();
      return { accepted, unknown };
    },
  };
}

/**
 * Read-only dump for offline tooling: one JSON object per line, oldest first. There is deliberately no HTTP endpoint
 * or UI for this, and nothing prunes the table.
 */
export function exportEventsJsonl(db: Db, write: (line: string) => void, opts: { since?: string } = {}): number {
  const rows = db
    .prepare(
      `SELECT id, item_id, at, kind, from_value, to_value, source, meta FROM item_events
        WHERE at >= ? ORDER BY id`,
    )
    .iterate(opts.since ?? '') as IterableIterator<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let n = 0;
  for (const r of rows) {
    let meta: unknown = null;
    if (typeof r.meta === 'string') {
      try {
        meta = JSON.parse(r.meta);
      } catch {
        meta = r.meta;
      }
    }
    const out: ItemEventRow = {
      id: r.id,
      itemId: r.item_id,
      at: r.at,
      kind: r.kind,
      from: r.from_value,
      to: r.to_value,
      source: r.source,
      meta: meta as ItemEventRow['meta'],
    };
    write(JSON.stringify(out) + '\n');
    n++;
  }
  return n;
}
