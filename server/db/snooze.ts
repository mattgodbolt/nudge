import { isSnoozeBucket, wholeDays } from '../../shared/snooze.js';
import type { Counts, SnoozeBucket, SnoozeResult } from '../../shared/types.js';
import type { GithubSnoozeItem, Repo, SnoozeOptions } from '../contracts.js';
import { iso, loadUndoable, type Row } from './common.js';
import type { Db } from './db.js';
import type { Events } from './events.js';
import { parseData } from './feeds.js';

export type SnoozeStore = Pick<
  Repo,
  | 'snooze'
  | 'undoSnooze'
  | 'snoozeReason'
  | 'snoozeNag'
  | 'assignSnoozeBucket'
  | 'mergeSnoozeMeta'
  | 'githubSnoozeContext'
  | 'wakeSnoozed'
>;

export interface SnoozeDeps {
  db: Db;
  clock: () => Date;
  now: () => string;
  events: Events;
  /** The sidebar counts every result carries. */
  counts: Repo['counts'];
}

/**
 * Snoozing by hand, its undo, the timer waker and the reason-bucket bookkeeping. Waking on activity lives in wake.ts,
 * because the GitHub poller (feeds.ts) and the YouTube sync (youtube.ts) both call it inside their own transactions.
 */
export function createSnooze(deps: SnoozeDeps): SnoozeStore {
  const { db, clock, now, events, counts } = deps;

  function snooze(
    ids: string[],
    until: string | null,
    why: string | null = null,
    opts: SnoozeOptions = {},
  ): SnoozeResult {
    return db.transaction(() => {
      const at = now();
      const target = until === null ? null : iso(until);
      const get = db.prepare(
        `SELECT state, snoozed_until, woke_at, snooze_why, snooze_bucket, snooze_until_activity, snoozed_at,
                snooze_wake_cause FROM items WHERE id = ?`,
      );
      // Snoozing again replaces the old reason, bucket and mode (or clears them when none is given); unsnoozing leaves
      // the reason and bucket alone (the item still shows why it was parked) but ends any wait for activity.
      const park = db.prepare(
        `UPDATE items SET snoozed_until = ?, woke_at = NULL, snooze_why = ?, snooze_bucket = ?,
           snooze_until_activity = ?, snoozed_at = ?, snooze_wake_cause = NULL WHERE id = ?`,
      );
      const unpark = db.prepare(
        'UPDATE items SET snoozed_until = NULL, woke_at = ?, snooze_until_activity = 0 WHERE id = ?',
      );
      const newWhy = why?.trim() ? why.trim() : null;
      const newBucket = opts.bucket ?? null;
      const untilActivity = target !== null && opts.untilActivity === true;
      const changes: SnoozeResult['changes'] = [];
      const stored: {
        commentId: string;
        from: string | null;
        fromWoke: string | null;
        to: string | null;
        fromWhy: string | null;
        fromBucket: SnoozeBucket | null;
        fromUntilActivity: boolean;
        fromSnoozedAt: string | null;
        fromWakeCause: string | null;
      }[] = [];
      for (const id of new Set(ids)) {
        const r = get.get(id) as Row | undefined;
        if (!r || r.state !== 'inbox') continue;
        // A past value is an already-ended snooze the waker has not swept yet: effectively not snoozed.
        const from: string | null = r.snoozed_until && r.snoozed_until > at ? r.snoozed_until : null;
        const fromWoke: string | null = r.woke_at ?? null;
        const same =
          target === null
            ? from === null
            : from === target &&
              fromWoke === null &&
              (r.snooze_bucket ?? null) === newBucket &&
              (r.snooze_until_activity === 1) === untilActivity;
        if (same) continue;
        if (target === null) unpark.run(fromWoke, id);
        else park.run(target, newWhy, newBucket, untilActivity ? 1 : 0, at, id);
        changes.push({ commentId: id, from, to: target });
        stored.push({
          commentId: id,
          from,
          fromWoke,
          to: target,
          fromWhy: r.snooze_why ?? null,
          fromBucket: r.snooze_bucket ?? null,
          fromUntilActivity: r.snooze_until_activity === 1,
          fromSnoozedAt: r.snoozed_at ?? null,
          fromWakeCause: r.snooze_wake_cause ?? null,
        });
      }
      if (changes.length === 0) return { actionId: null, changes, counts: counts() };
      const res = db
        .prepare('INSERT INTO triage_actions (created_at, to_state, changes) VALUES (?, ?, ?)')
        .run(at, 'snoozed', JSON.stringify(stored));
      const actionId = Number(res.lastInsertRowid);
      for (const c of changes) {
        events.record({
          itemId: c.commentId,
          at,
          kind: 'snooze',
          from: c.from,
          to: c.to,
          source: 'user',
          meta: {
            actionId,
            ...(newWhy && c.to !== null ? { why: newWhy } : {}),
            // Absent means none / not waiting, so ordinary snoozes keep their old shape.
            ...(c.to !== null
              ? { ...(newBucket ? { bucket: newBucket } : {}), ...(untilActivity ? { untilActivity } : {}) }
              : { cause: 'manual' }),
          },
        });
      }
      return { actionId, changes, counts: counts() };
    })();
  }

  function snoozeReason(itemId: string): string | null {
    const r = db.prepare('SELECT snooze_why FROM items WHERE id = ?').get(itemId) as Row | undefined;
    return r?.snooze_why ?? null;
  }

  function snoozeNag(itemId: string): { bucket: SnoozeBucket | null; days: number; why: string | null } | null {
    const r = db
      .prepare(
        `SELECT state, snoozed_until, woke_at, snoozed_at, snooze_bucket, snooze_why, snooze_wake_cause
           FROM items WHERE id = ?`,
      )
      .get(itemId) as Row | undefined;
    if (!r || r.state !== 'inbox' || r.snoozed_until || r.snooze_wake_cause !== 'fallback') return null;
    return {
      bucket: isSnoozeBucket(r.snooze_bucket) ? r.snooze_bucket : null,
      days: wholeDays(r.snoozed_at ?? null, r.woke_at ?? null),
      why: r.snooze_why ?? null,
    };
  }

  function assignSnoozeBucket(itemId: string, actionId: number, bucket: SnoozeBucket): boolean {
    return db.transaction(() => {
      const ev0 = db
        .prepare(
          "SELECT id, to_value FROM item_events WHERE item_id = ? AND kind = 'snooze' AND source = 'user' AND json_extract(meta, '$.actionId') = ? ORDER BY id LIMIT 1",
        )
        .get(itemId, actionId) as Row | undefined;
      if (!ev0?.to_value) return false;
      // Only the snooze that asked for it, still in force and still without a reason bucket.
      const r = db
        .prepare(
          "UPDATE items SET snooze_bucket = ? WHERE id = ? AND snooze_bucket IS NULL AND snoozed_until = ? AND state = 'inbox'",
        )
        .run(bucket, itemId, ev0.to_value);
      if (r.changes === 0) return false;
      events.mergeSnoozeMeta(itemId, actionId, { bucket, bucketAuto: true });
      return true;
    })();
  }

  function githubSnoozeContext(ids: string[]): GithubSnoozeItem[] {
    if (ids.length === 0) return [];
    const rows = db
      .prepare(
        `SELECT id, kind, container_key, data FROM items WHERE provider = 'github'
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as { id: string; kind: string; container_key: string | null; data: string | null }[];
    return rows.map((r) => {
      const d = parseData(r.data);
      return {
        id: r.id,
        kind: r.kind === 'pr' ? 'pr' : 'issue',
        repo: r.container_key ?? '',
        number: typeof d.number === 'number' ? d.number : 0,
        comments: typeof d.comments === 'number' ? d.comments : 0,
        createdAt: typeof d.createdAt === 'string' ? d.createdAt : null,
        draft: d.draft === true,
      };
    });
  }

  function undoSnooze(actionId: number): SnoozeResult {
    return db.transaction(() => {
      const a = loadUndoable(db, clock, actionId, true);
      const stored = JSON.parse(a.changes) as {
        commentId: string;
        from: string | null;
        fromWoke: string | null;
        to: string | null;
        fromWhy?: string | null;
        fromBucket?: SnoozeBucket | null;
        fromUntilActivity?: boolean;
        fromSnoozedAt?: string | null;
        fromWakeCause?: string | null;
      }[];
      // Only restore comments still in the state this action left them in. Undoing a snooze brings back the reason,
      // bucket and mode the item had before it (and the audit mark, if it had one); undoing an unsnooze leaves the
      // reason and bucket as they are, and puts the wait for activity back.
      const restore = db.prepare(
        `UPDATE items SET snoozed_until = ?, woke_at = ?,
           snooze_why = CASE WHEN @park = 1 THEN @why ELSE snooze_why END,
           snooze_bucket = CASE WHEN @park = 1 THEN @bucket ELSE snooze_bucket END,
           snooze_until_activity = @ua, snoozed_at = CASE WHEN @park = 1 THEN @sat ELSE snoozed_at END,
           snooze_wake_cause = @cause
         WHERE id = @id AND state = 'inbox' AND snoozed_until IS @to`,
      );
      const changes: SnoozeResult['changes'] = [];
      const at = now();
      for (const c of stored) {
        const res = restore.run(c.from, c.fromWoke, {
          park: c.to !== null ? 1 : 0,
          why: c.fromWhy ?? null,
          bucket: c.fromBucket ?? null,
          ua: c.fromUntilActivity ? 1 : 0,
          sat: c.fromSnoozedAt ?? null,
          cause: c.fromWakeCause ?? null,
          id: c.commentId,
          to: c.to,
        });
        if (res.changes) {
          changes.push({ commentId: c.commentId, from: c.to, to: c.from });
          events.record({
            itemId: c.commentId,
            at,
            kind: 'undo',
            from: c.to,
            to: c.from,
            source: 'user',
            meta: { actionId, original: 'snooze', originalEventId: events.originalEventId(c.commentId, actionId) },
          });
        }
      }
      db.prepare('UPDATE triage_actions SET undone_at = ? WHERE id = ?').run(at, actionId);
      return { actionId, changes, counts: counts() };
    })();
  }

  function wakeSnoozed(): { woken: string[]; counts: Counts } {
    return db.transaction(() => {
      const at = now();
      const due = db
        .prepare(
          `SELECT id, state, snoozed_until, snooze_until_activity, snooze_bucket FROM items
            WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?`,
        )
        .all(at) as Row[];
      if (due.length === 0) return { woken: [], counts: counts() };
      // Only inbox items are recorded: waking anything else changes nothing the user sees.
      for (const r of due) {
        if (r.state === 'inbox') {
          // An item that was waiting on activity and reached its fallback date came back with none: the audit nag.
          const waiting = r.snooze_until_activity === 1;
          events.record({
            itemId: r.id,
            at,
            kind: 'snooze',
            from: r.snoozed_until,
            to: null,
            source: 'auto',
            meta: {
              reason: 'wake',
              ...(waiting ? { untilActivity: true, cause: 'fallback', bucket: r.snooze_bucket ?? null } : {}),
            },
          });
        }
      }
      db.prepare(
        `UPDATE items SET woke_at = snoozed_until,
           snooze_wake_cause = CASE WHEN snooze_until_activity = 1 THEN 'fallback' ELSE snooze_wake_cause END,
           snoozed_until = NULL
         WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?`,
      ).run(at);
      // Only inbox comments change what the user sees; others are tidied silently.
      return { woken: due.filter((r) => r.state === 'inbox').map((r) => r.id as string), counts: counts() };
    })();
  }

  return {
    snooze,
    undoSnooze,
    snoozeReason,
    snoozeNag,
    assignSnoozeBucket,
    mergeSnoozeMeta: events.mergeSnoozeMeta,
    githubSnoozeContext,
    wakeSnoozed,
  };
}
