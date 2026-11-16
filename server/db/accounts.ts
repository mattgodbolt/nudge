import type { GoogleAccountRow, Repo, YtComment } from '../contracts.js';
import { iso, type Row } from './common.js';
import type { Db } from './db.js';
import type { DraftsStore } from './drafts.js';
import type { Events } from './events.js';

export type AccountsStore = Pick<
  Repo,
  | 'listGoogleAccounts'
  | 'upsertGoogleAccount'
  | 'updateGoogleAccount'
  | 'deleteGoogleAccount'
  | 'setDefaultGoogleAccount'
  | 'beginReplyPost'
  | 'finishReplyPost'
  | 'recentPostedReply'
  | 'isAppPostedReply'
  | 'recordPostedReply'
>;

export interface AccountsDeps {
  db: Db;
  now: () => string;
  events: Events;
  saveDraft: DraftsStore['saveDraft'];
  triage: Repo['triage'];
  addReplies: Repo['addReplies'];
}

/** Connected Google accounts (for posting replies) and the log of replies posted through them. */
export function createAccounts(deps: AccountsDeps): AccountsStore {
  const { db, now, events, saveDraft, triage, addReplies } = deps;

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
      events.record({
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

  return {
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
  };
}
