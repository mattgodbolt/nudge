import type { Db } from './db.js';
import type { Events } from './events.js';

/**
 * Wake items snoozed "until activity" because something happened on them, from whoever noticed first (the GitHub
 * poller, the YouTube sync). Writes the same shape of event the timer waker writes (kind snooze, to null, source
 * auto, meta.reason 'wake') with cause 'activity', so the habits report counts both alike. The caller must be inside
 * the transaction that stored the activity, so the wake and what caused it commit together.
 *
 * Only inbox items that are still snoozed with the until-activity flag change; anything else in `ids` is ignored, so
 * callers can pass every item an event touched. Also drops the audit mark on an item that already came back with no
 * activity: the thread has moved since, so "no activity" would no longer be true.
 *
 * `keepInbox` makes the item stay in the inbox against the sync's own rules (used when the item was closed upstream:
 * the owner parked it on purpose, so they should see what happened rather than have it filed away as resolved).
 * Returns the ids that woke.
 */
export function wakeOnActivity(
  db: Db,
  ev: Events,
  ids: string[],
  at: string,
  detail: Record<string, unknown> = {},
  keepInbox = false,
): string[] {
  if (ids.length === 0) return [];
  const json = JSON.stringify(ids);
  const due = db
    .prepare(
      `SELECT id, snoozed_until, snooze_bucket FROM items
        WHERE id IN (SELECT value FROM json_each(?)) AND state = 'inbox' AND snooze_until_activity = 1
          AND snoozed_until IS NOT NULL AND snoozed_until > ?`,
    )
    .all(json, at) as { id: string; snoozed_until: string; snooze_bucket: string | null }[];
  const wake = db.prepare(
    `UPDATE items SET woke_at = ?, snoozed_until = NULL, snooze_wake_cause = 'activity',
       reason = CASE WHEN provider = 'github' THEN 'new_activity' ELSE reason END${keepInbox ? ", state_source = 'user'" : ''} WHERE id = ?`,
  );
  for (const r of due) {
    ev.record({
      itemId: r.id,
      at,
      kind: 'snooze',
      from: r.snoozed_until,
      to: null,
      source: 'auto',
      meta: { reason: 'wake', cause: 'activity', untilActivity: true, bucket: r.snooze_bucket, ...detail },
    });
    wake.run(at, r.id);
  }
  db.prepare(
    `UPDATE items SET snooze_wake_cause = NULL
      WHERE id IN (SELECT value FROM json_each(?)) AND state = 'inbox' AND snooze_wake_cause = 'fallback'`,
  ).run(json);
  return due.map((r) => r.id);
}
