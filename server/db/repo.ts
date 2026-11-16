/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CommentState, DoneReason, Counts, SnoozeBucket, SnoozeResult, TriageResult } from '../../shared/types.js';
import type { DraftDTO } from '../../shared/api.js';
import { isSnoozeBucket, wholeDays } from '../../shared/snooze.js';
import type { GithubSnoozeItem, GoogleAccountRow, SnoozeOptions, Repo, YtComment } from '../contracts.js';
import { openDb, type Db } from './db.js';
import { createClientEvents, createEvents } from './events.js';
import { createFeedsRepo, parseData } from './feeds.js';
import { createTodosRepo } from './todos.js';
import { createUsage } from './usage.js';
import { createSpend } from './spend.js';
import { createNotes } from './notes.js';
import { createSuggestions } from './suggestions.js';
import { createQuota } from './quota.js';
import { createSettings } from './settings.js';
import { createYoutube } from './youtube.js';
import { createInbox } from './inbox.js';

import { iso, loadUndoable as loadUndoableIn, type Row } from './common.js';

export { UndoError, type UndoErrorCode } from './common.js';

export function createRepo(db: Db, clock: () => Date = () => new Date()): Repo {
  const now = () => clock().toISOString();

  const { putSetting, ...settingsMethods } = createSettings({
    db,
    now,
    recomputeOwnership: (ids) => youtube.recomputeOwnership(ids),
    recomputeGithubOwnership: () => feeds.recomputeGithubOwnership(),
  });
  const { getSettings } = settingsMethods;

  const ev = createEvents(db);
  const youtube = createYoutube({ db, clock, now, events: ev, getSettings, putSetting });
  const { baselineFor: _baselineFor, ...youtubeMethods } = youtube;
  const { addReplies } = youtube;

  const feeds = createFeedsRepo({
    db,
    now,
    events: ev,
    myAccounts: () => new Set(getSettings().github.myAccounts.map((l) => l.toLowerCase())),
    baselineFor: (mode) => youtube.baselineFor(mode),
  });
  const inbox = createInbox({ db, clock, now, itemFromRow: feeds.itemFromRow });
  const { counts, getComment } = inbox;

  /* ---------------- triage ---------------- */
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
        ev.record({
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
        ev.record({
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

  const loadUndoable = (actionId: number, snooze: boolean): Row => loadUndoableIn(db, clock, actionId, snooze);

  function undo(actionId: number): TriageResult {
    return db.transaction(() => {
      const a = loadUndoable(actionId, false);
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
          ev.record({
            itemId: c.commentId,
            at,
            kind: 'undo',
            from: a.to_state,
            to: c.from,
            source: 'user',
            meta: { actionId, original: 'state', originalEventId: ev.originalEventId(c.commentId, actionId) },
          });
        }
      }
      db.prepare('UPDATE triage_actions SET undone_at = ? WHERE id = ?').run(at, actionId);
      return { actionId, changes, counts: counts() };
    })();
  }

  /* ---------------- snooze ---------------- */
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
        ev.record({
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
      ev.mergeSnoozeMeta(itemId, actionId, { bucket, bucketAuto: true });
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
      const a = loadUndoable(actionId, true);
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
          ev.record({
            itemId: c.commentId,
            at,
            kind: 'undo',
            from: c.to,
            to: c.from,
            source: 'user',
            meta: { actionId, original: 'snooze', originalEventId: ev.originalEventId(c.commentId, actionId) },
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
          ev.record({
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

  /* ---------------- drafts ---------------- */
  function draftDto(r: Row): DraftDTO {
    return { body: r.body, updatedAt: r.updated_at, status: r.status };
  }
  function getDraft(commentId: string): DraftDTO | null {
    const r = db.prepare('SELECT * FROM drafts WHERE item_id = ?').get(commentId) as Row | undefined;
    return r ? draftDto(r) : null;
  }
  function saveDraft(commentId: string, body: string, status: DraftDTO['status']): DraftDTO {
    db.prepare(
      `INSERT INTO drafts (item_id, body, updated_at, status) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
         status = excluded.status`,
    ).run(commentId, body, now(), status);
    return getDraft(commentId)!;
  }

  function markHandedOff(commentId: string, body: string): TriageResult {
    return db.transaction(() => {
      if (!getComment(commentId)) throw new Error(`Unknown comment ${commentId}`);
      saveDraft(commentId, body, 'handed_off');
      return triage([commentId], 'replied');
    })();
  }

  /* ---------------- Google accounts + reply posts ---------------- */
  const accountRow = (r: Row): GoogleAccountRow => ({
    channelId: r.channel_id,
    title: r.channel_title,
    thumbnailUrl: r.channel_thumb,
    refreshToken: r.refresh_token,
    accessToken: r.access_token,
    accessExpiresAt: r.access_expires_at,
    scope: r.scope,
    connectedAt: r.connected_at,
    needsReauth: !!r.needs_reauth,
    lastError: r.last_error,
    isDefault: !!r.is_default,
  });
  const ACCOUNT_COLUMNS: Record<keyof GoogleAccountRow, string> = {
    channelId: 'channel_id',
    title: 'channel_title',
    thumbnailUrl: 'channel_thumb',
    refreshToken: 'refresh_token',
    accessToken: 'access_token',
    accessExpiresAt: 'access_expires_at',
    scope: 'scope',
    connectedAt: 'connected_at',
    needsReauth: 'needs_reauth',
    lastError: 'last_error',
    isDefault: 'is_default',
  };
  const dbVal = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

  function listGoogleAccounts(): GoogleAccountRow[] {
    return (db.prepare('SELECT * FROM google_accounts ORDER BY connected_at, channel_id').all() as Row[]).map(
      accountRow,
    );
  }

  /** Keep exactly one default while any account exists (the earliest-connected wins if none is flagged). */
  function normaliseDefault(preferred?: string): void {
    const rows = db
      .prepare('SELECT channel_id, is_default FROM google_accounts ORDER BY connected_at, channel_id')
      .all() as Row[];
    if (rows.length === 0) return;
    let pick: string | undefined = preferred && rows.some((r) => r.channel_id === preferred) ? preferred : undefined;
    pick ??= (rows.find((r) => r.is_default) ?? rows[0]!).channel_id;
    db.prepare('UPDATE google_accounts SET is_default = (channel_id = ?)').run(pick);
  }

  function upsertGoogleAccount(a: GoogleAccountRow): void {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO google_accounts (channel_id, channel_title, channel_thumb, refresh_token, access_token,
           access_expires_at, scope, connected_at, needs_reauth, last_error, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET channel_title = excluded.channel_title,
           channel_thumb = excluded.channel_thumb, refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
           scope = excluded.scope, connected_at = excluded.connected_at, needs_reauth = excluded.needs_reauth,
           last_error = excluded.last_error,
           is_default = CASE WHEN excluded.is_default = 1 THEN 1 ELSE google_accounts.is_default END`,
      ).run(
        a.channelId,
        a.title,
        a.thumbnailUrl,
        a.refreshToken,
        a.accessToken,
        a.accessExpiresAt,
        a.scope,
        a.connectedAt,
        a.needsReauth ? 1 : 0,
        a.lastError,
        a.isDefault ? 1 : 0,
      );
      // The first account is always the default; an explicit default elsewhere wins over the flag on the others.
      const hasOtherDefault = db
        .prepare('SELECT 1 FROM google_accounts WHERE is_default = 1 AND channel_id != ?')
        .get(a.channelId);
      if (a.isDefault) normaliseDefault(a.channelId);
      else if (!hasOtherDefault) normaliseDefault();
    })();
  }

  function updateGoogleAccount(channelId: string, p: Partial<GoogleAccountRow>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(p) as [keyof GoogleAccountRow, unknown][]) {
      const col = ACCOUNT_COLUMNS[k];
      if (!col || v === undefined || k === 'channelId' || k === 'isDefault') continue;
      sets.push(`${col} = ?`);
      vals.push(dbVal(v));
    }
    db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE google_accounts SET ${sets.join(', ')} WHERE channel_id = ?`).run(...vals, channelId);
      }
      if (p.isDefault === true) normaliseDefault(channelId);
    })();
  }

  function deleteGoogleAccount(channelId: string): void {
    db.transaction(() => {
      db.prepare('DELETE FROM google_accounts WHERE channel_id = ?').run(channelId);
      normaliseDefault();
    })();
  }

  function setDefaultGoogleAccount(channelId: string): void {
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM google_accounts WHERE channel_id = ?').get(channelId)) {
        throw new Error(`Unknown Google account ${channelId}`);
      }
      normaliseDefault(channelId);
    })();
  }

  function beginReplyPost(commentId: string, bodyHash: string): number {
    const res = db
      .prepare("INSERT INTO reply_posts (comment_id, body_hash, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(commentId, bodyHash, now());
    return Number(res.lastInsertRowid);
  }

  function finishReplyPost(
    id: number,
    p: {
      status: 'posted' | 'failed' | 'unknown';
      postedCommentId?: string | null;
      viaChannelId?: string | null;
      error?: string | null;
    },
  ): void {
    db.prepare(
      `UPDATE reply_posts SET status = ?, posted_comment_id = COALESCE(?, posted_comment_id),
         via_channel_id = COALESCE(?, via_channel_id), error = ? WHERE id = ?`,
    ).run(p.status, p.postedCommentId ?? null, p.viaChannelId ?? null, p.error ?? null, id);
  }

  function recentPostedReply(
    commentId: string,
    bodyHash: string,
    sinceIso: string,
  ): { postedCommentId: string } | null {
    const r = db
      .prepare(
        `SELECT posted_comment_id FROM reply_posts
         WHERE comment_id = ? AND body_hash = ? AND status = 'posted' AND posted_comment_id IS NOT NULL
           AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(commentId, bodyHash, iso(sinceIso)) as Row | undefined;
    return r ? { postedCommentId: r.posted_comment_id } : null;
  }

  function isAppPostedReply(commentId: string): boolean {
    return !!db
      .prepare("SELECT 1 FROM reply_posts WHERE posted_comment_id = ? AND status = 'posted' LIMIT 1")
      .get(commentId);
  }

  function recordPostedReply(p: {
    commentId: string;
    body: string;
    posted: YtComment;
    viaChannelId: string;
    replyPostId: number;
  }): { actionId: number; newCommentIds: string[]; changedIds: string[] } {
    return db.transaction(() => {
      const target = db.prepare('SELECT thread_id FROM comments WHERE id = ?').get(p.commentId) as Row | undefined;
      if (!target) throw new Error(`Unknown comment ${p.commentId}`);
      saveDraft(p.commentId, p.body, 'posted');
      // Triage first so the target is a 'user' state that the auto-clear below must not touch.
      const t = triage([p.commentId], 'replied');
      ev.record({
        itemId: p.commentId,
        at: now(),
        kind: 'reply',
        source: 'user',
        meta: {
          replyPostId: p.replyPostId,
          postedCommentId: p.posted.id,
          viaChannelId: p.viaChannelId,
          actionId: t.actionId,
        },
      });
      const added = addReplies(target.thread_id, [p.posted]);
      finishReplyPost(p.replyPostId, {
        status: 'posted',
        postedCommentId: p.posted.id,
        viaChannelId: p.viaChannelId,
      });
      const changed = new Set([...t.changes.map((c) => c.commentId), ...added.changedIds]);
      return { actionId: t.actionId, newCommentIds: added.newCommentIds, changedIds: [...changed] };
    })();
  }

  const todos = createTodosRepo({ db, now });
  const { itemFromRow: _itemFromRow, ...feedMethods } = feeds;

  return {
    ...feedMethods,
    ...todos,
    close: () => void db.close(),
    usage: createUsage(db, clock),
    spend: createSpend(db, clock),
    suggestions: createSuggestions(db, clock),
    notes: createNotes(db, clock),
    clientEvents: createClientEvents(db),
    listGoogleAccounts,
    upsertGoogleAccount,
    updateGoogleAccount,
    deleteGoogleAccount,
    setDefaultGoogleAccount,
    beginReplyPost,
    finishReplyPost,
    recentPostedReply,
    isAppPostedReply,
    recordPostedReply,
    ...settingsMethods,
    githubSnoozeContext,
    mergeSnoozeMeta: ev.mergeSnoozeMeta,
    ...youtubeMethods,
    ...inbox,
    triage,
    undo,
    snooze,
    undoSnooze,
    snoozeReason,
    snoozeNag,
    assignSnoozeBucket,
    wakeSnoozed,
    markHandedOff,
    getDraft,
    putDraft: (commentId, body) => saveDraft(commentId, body, 'draft'),
    deleteDraft: (commentId) => void db.prepare('DELETE FROM drafts WHERE item_id = ?').run(commentId),
    ...createQuota({ db, now }),
  };
}

export function openRepo(path: string, clock?: () => Date): Repo {
  return createRepo(openDb(path), clock);
}
