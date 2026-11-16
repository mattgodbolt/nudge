/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  CommentDTO,
  CommentState,
  DoneReason,
  Counts,
  InboxItem,
  SnoozeBucket,
  SnoozeResult,
  ThreadDetail,
  TriageResult,
} from '../../shared/types.js';
import type { DraftDTO, InboxPage, InboxQuery } from '../../shared/api.js';
import { permalink } from '../../shared/youtube-urls.js';
import { SNOOZE_BUCKETS, WAKE_CAUSES, isSnoozeBucket, wholeDays } from '../../shared/snooze.js';
import type { GithubSnoozeItem, GoogleAccountRow, SnoozeOptions, Repo, YtComment } from '../contracts.js';
import { openDb, type Db } from './db.js';
import { createClientEvents, createEvents } from './events.js';
import { createFeedsRepo, parseData } from './feeds.js';
import { createTodosRepo } from './todos.js';
import { createUsage } from './usage.js';
import { createSpend } from './spend.js';
import { createNotes } from './notes.js';
import { createSuggestions, suggestionDto } from './suggestions.js';
import { createQuota } from './quota.js';
import { createSettings } from './settings.js';
import { createYoutube, VIDEO_SELECT, videoDto } from './youtube.js';

import { iso, loadUndoable as loadUndoableIn, type Row } from './common.js';

export { UndoError, type UndoErrorCode } from './common.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** A dismissal's marker, only while the item is actually done (the column is cleared on triage, but be safe). */
function doneReasonOf(r: Row): { doneReason?: DoneReason } {
  return r.state === 'done' && r.done_reason === 'no_action' ? { doneReason: 'no_action' } : {};
}

/** The snooze facts of an item row (needs i.snooze_bucket, snooze_until_activity, snoozed_at, snooze_wake_cause). */
function snoozeFields(
  r: Row,
  at: string,
): Pick<InboxItem, 'snoozeBucket' | 'snoozeUntilActivity' | 'snoozedAt' | 'wakeCause' | 'snoozeNag'> {
  const snoozed = !!r.snoozed_until && r.snoozed_until > at;
  const shown = snoozed || !!r.woke_at;
  const bucket: SnoozeBucket | null = isSnoozeBucket(r.snooze_bucket) ? r.snooze_bucket : null;
  const nag = !snoozed && r.state === 'inbox' && r.snooze_wake_cause === 'fallback';
  return {
    snoozeBucket: shown ? bucket : null,
    snoozeUntilActivity: snoozed && r.snooze_until_activity === 1,
    snoozedAt: shown ? (r.snoozed_at ?? null) : null,
    wakeCause: !snoozed && WAKE_CAUSES.includes(r.snooze_wake_cause) ? r.snooze_wake_cause : null,
    snoozeNag: nag ? { bucket, days: wholeDays(r.snoozed_at ?? null, r.woke_at ?? null) } : null,
  };
}

function commentDto(r: Row): CommentDTO {
  return {
    id: r.id,
    threadId: r.thread_id,
    parentId: r.parent_id,
    videoId: r.video_id,
    authorName: r.author_name,
    authorChannelId: r.author_channel_id,
    authorAvatarUrl: r.author_avatar_url,
    textHtml: r.text_html,
    textPlain: r.text_plain,
    likeCount: r.like_count,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
    isOwn: !!r.is_own,
    state: r.state,
    stateSource: r.state_source,
    ...doneReasonOf(r),
    permalink: permalink(r.video_id, r.id),
    postedByApp: !!r.posted_by_app,
  };
}

/** Turn free text into an FTS5 prefix-AND query; null when there is nothing searchable. */
function ftsQuery(q: string): string | null {
  const tokens = q.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

export function createRepo(db: Db, clock: () => Date = () => new Date()): Repo {
  const now = () => clock().toISOString();
  const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  /* ---------------- reading ---------------- */
  const INBOX_SELECT = `SELECT c.*, i.id AS item_id, i.provider, i.kind, i.title AS i_title, i.author AS i_author,
      i.author_avatar_url AS i_avatar, i.is_own AS i_own, i.body_plain, i.url AS i_url, i.container_key,
      i.container_title, i.source_state, i.reason, i.muted, i.data, i.occurred_at,
      i.state, i.state_source, i.done_reason, i.state_changed_at, i.snoozed_until, i.woke_at, i.first_seen_at AS arrived_at,
      v.title AS v_title, v.thumbnail_url AS v_thumb,
      p.id AS p_id, p.author_name AS p_author, p.text_plain AS p_text, p.is_own AS p_own,
      t.total_reply_count AS t_total,
      EXISTS (SELECT 1 FROM drafts d WHERE d.item_id = i.id AND d.status = 'draft') AS has_draft,
      sg.verdict AS sg_verdict, sg.confidence AS sg_confidence, sg.reason AS sg_reason,
      sg.injection_attempt AS sg_injection, sg.turn AS sg_turn, sg.next_step AS sg_next_step, i.snooze_why,
      i.snooze_bucket, i.snooze_until_activity, i.snoozed_at, i.snooze_wake_cause
    FROM items i
    LEFT JOIN suggestions sg ON sg.item_id = i.id
    LEFT JOIN comments c ON c.id = i.id
    LEFT JOIN videos v ON v.id = c.video_id
    LEFT JOIN threads t ON t.id = c.thread_id
    LEFT JOIN comments p ON p.id = c.parent_id`;

  /** SQL fragments for "needs attention now" (inbox state and not currently snoozed); bind @now. */
  const NOT_SNOOZED = '(i.snoozed_until IS NULL OR i.snoozed_until <= @now)';
  const SORT_VALUE = 'COALESCE(i.woke_at, i.occurred_at)';
  const ARRIVED_VALUE = 'COALESCE(i.woke_at, i.first_seen_at)';
  const RANK = "(CASE i.provider WHEN 'todo' THEN 0 WHEN 'github' THEN 1 ELSE 2 END)";
  /** The Snoozed view lists by reason bucket, in the order of SNOOZE_BUCKETS, with no bucket last. */
  const BUCKET_RANK = `(CASE i.snooze_bucket ${SNOOZE_BUCKETS.map((b, n) => `WHEN '${b}' THEN ${n}`).join(' ')} ELSE ${SNOOZE_BUCKETS.length} END)`;
  const bucketRank = (b: unknown): number => {
    const n = (SNOOZE_BUCKETS as readonly unknown[]).indexOf(b);
    return n < 0 ? SNOOZE_BUCKETS.length : n;
  };

  function inboxItem(r: Row, at: string): InboxItem {
    const item = feeds.itemFromRow(r);
    const youtube = r.provider === 'youtube';
    // Non-YouTube items get a comment-shaped stand-in so selection, snooze and undo work unchanged.
    const comment: CommentDTO = youtube
      ? commentDto({ ...r, id: r.item_id })
      : {
          id: r.item_id,
          threadId: r.item_id,
          parentId: null,
          videoId: r.container_key ?? '',
          authorName: r.i_author ?? '',
          authorChannelId: null,
          authorAvatarUrl: r.i_avatar ?? null,
          textHtml: escapeHtml(r.body_plain ?? ''),
          textPlain: r.body_plain ?? '',
          likeCount: 0,
          publishedAt: r.occurred_at,
          updatedAt: r.occurred_at,
          isOwn: !!r.i_own,
          state: r.state,
          stateSource: r.state_source,
          ...doneReasonOf(r),
          permalink: r.i_url ?? '',
          postedByApp: false,
        };
    return {
      item,
      comment,
      video: youtube
        ? { id: r.video_id, title: r.v_title, thumbnailUrl: r.v_thumb }
        : { id: r.container_key ?? '', title: r.container_title ?? '', thumbnailUrl: null },
      parent: r.p_id ? { id: r.p_id, authorName: r.p_author, textPlain: r.p_text, isOwn: !!r.p_own } : null,
      arrivedAt: r.arrived_at,
      threadReplyCount: r.t_total ?? 0,
      hasDraft: !!r.has_draft,
      snoozedUntil: r.snoozed_until && r.snoozed_until > at ? r.snoozed_until : null,
      wokeAt: r.woke_at ?? null,
      // Shown while snoozed and after it wakes; once the item has never been snoozed there is nothing to show.
      snoozeWhy: r.snooze_why && (r.woke_at || (r.snoozed_until && r.snoozed_until > at)) ? r.snooze_why : null,
      ...snoozeFields(r, at),
      suggestion: r.sg_verdict
        ? suggestionDto({
            verdict: r.sg_verdict,
            confidence: r.sg_confidence,
            reason: r.sg_reason,
            injection: !!r.sg_injection,
            turn: r.sg_turn,
            nextStep: r.sg_next_step,
          })
        : null,
    };
  }

  function listInbox(q: InboxQuery): InboxPage {
    const where: string[] = [];
    const at = now();
    const args: Record<string, unknown> = { now: at };
    if (q.view === 'inbox') where.push(`i.state = 'inbox' AND ${NOT_SNOOZED}`);
    else if (q.view === 'snoozed') where.push("i.state = 'inbox' AND i.snoozed_until > @now");
    else if (q.view === 'done') where.push("i.state IN ('done','replied','auto_replied','resolved')");
    else where.push("i.state != 'own'");
    if (q.sourceId !== undefined) {
      where.push(
        "i.provider = 'youtube' AND i.container_key IN (SELECT video_id FROM source_videos WHERE source_id = @sourceId)",
      );
      args.sourceId = q.sourceId;
    }
    if (q.videoId) {
      where.push('i.container_key = @videoId');
      args.videoId = q.videoId;
    }
    if (q.repo) {
      where.push("i.provider = 'github' AND i.container_key = @repo COLLATE NOCASE");
      args.repo = q.repo;
    }
    if (q.feedId !== undefined) {
      where.push('i.feed_id = @feedId');
      args.feedId = q.feedId;
    }
    if (q.kind) {
      where.push('i.kind = @kind');
      args.kind = q.kind;
    }
    if (q.audience) {
      const assoc = "json_extract(i.data, '$.association')";
      const bot = "COALESCE(json_extract(i.data, '$.authorType'), '') = 'Bot'";
      const by: Record<string, string> = {
        outside: `${assoc} IN ('NONE','FIRST_TIME_CONTRIBUTOR','FIRST_TIMER','MANNEQUIN') AND NOT ${bot}`,
        team: `${assoc} IN ('OWNER','MEMBER','COLLABORATOR') AND NOT ${bot}`,
        contributors: `${assoc} = 'CONTRIBUTOR' AND NOT ${bot}`,
        bots: bot,
        people: `NOT ${bot}`,
      };
      const clause = by[q.audience];
      if (clause) where.push(`i.provider = 'github' AND ${clause}`);
    }
    if (q.suggestion) {
      // An injection flag hides the suggestion's action (suggestionDto), so those rows only match 'suspicious'.
      const sg = (cond: string) =>
        `EXISTS (SELECT 1 FROM suggestions sx WHERE sx.item_id = i.id AND sx.injection_attempt = 0 AND ${cond})`;
      const bySuggestion: Record<string, string> = {
        reply: sg("sx.verdict = 'needs_reply'"),
        act: sg("sx.verdict = 'needs_action'"),
        skip: sg("sx.verdict = 'no_reply_needed'"),
        spam: sg("sx.verdict = 'spam'"),
        matt: sg("sx.turn = 'matt'"),
        them: sg("sx.turn = 'them'"),
        suspicious: 'EXISTS (SELECT 1 FROM suggestions sx WHERE sx.item_id = i.id AND sx.injection_attempt = 1)',
        none: 'NOT EXISTS (SELECT 1 FROM suggestions sx WHERE sx.item_id = i.id)',
      };
      const clause = bySuggestion[q.suggestion];
      if (clause) where.push(clause);
    }
    if (q.ids) {
      where.push('i.id IN (SELECT value FROM json_each(@ids))');
      args.ids = JSON.stringify(q.ids);
    }
    if (q.q && q.q.trim()) {
      const fts = ftsQuery(q.q);
      if (!fts) return { items: [], nextCursor: null, total: 0 };
      where.push('i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH @fts)');
      args.fts = fts;
    }
    const base = where.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${base}`).get(args) as Row).n as number;

    // Every order is a keyset (rank?, key, id), so paging stays stable however the list is sorted.
    const order = q.order ?? 'newest';
    const key = order === 'arrived' ? ARRIVED_VALUE : SORT_VALUE;
    const dir = order === 'oldest' ? 'ASC' : 'DESC';
    const cmp = order === 'oldest' ? '>' : '<';
    // The Snoozed view is sectioned by reason bucket, whatever the sort: the rank is the bucket there.
    const grouped = q.view === 'snoozed';
    const ranked = order === 'source' || grouped;
    const RANKSQL = grouped ? BUCKET_RANK : RANK;
    const pageWhere = [base];
    if (q.cursor) {
      const parts = q.cursor.split('|');
      // [rank|]key|id (an id never contains "|"); a cursor from another order is ignored rather than trusted.
      if (parts.length === (ranked ? 3 : 2)) {
        const id = parts.pop()!;
        const k = parts.pop()!;
        args.cId = id;
        args.cKey = k;
        const after = `(${key} ${cmp} @cKey OR (${key} = @cKey AND i.id > @cId))`;
        if (ranked) {
          args.cRank = Number(parts[0]);
          pageWhere.push(`(${RANKSQL} > @cRank OR (${RANKSQL} = @cRank AND ${after}))`);
        } else {
          pageWhere.push(after);
        }
      }
    }
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const rows = db
      .prepare(
        `${INBOX_SELECT} WHERE ${pageWhere.join(' AND ')}
         ORDER BY ${ranked ? `${RANKSQL} ASC, ` : ''}${key} ${dir}, i.id ASC LIMIT @lim`,
      )
      .all({ ...args, lim: limit + 1 }) as Row[];
    const more = rows.length > limit;
    const pageRows = more ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map((r) => inboxItem(r, at)),
      nextCursor:
        more && last
          ? `${ranked ? `${grouped ? bucketRank(last.snooze_bucket) : last.provider === 'todo' ? 0 : last.provider === 'github' ? 1 : 2}|` : ''}${
              order === 'arrived' ? (last.woke_at ?? last.arrived_at) : (last.woke_at ?? last.occurred_at)
            }|${last.item_id}`
          : null,
      total,
    };
  }

  function getThread(threadId: string): ThreadDetail | null {
    const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (!t) return null;
    const v = db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(t.video_id) as Row;
    const rows = db
      .prepare(
        `SELECT comments.*, i.state, i.state_source, i.done_reason,
           (SELECT 1 FROM reply_posts rp WHERE rp.posted_comment_id = comments.id AND rp.status = 'posted') IS NOT NULL AS posted_by_app
         FROM comments JOIN items i ON i.id = comments.id WHERE thread_id = ?
         ORDER BY (parent_id IS NOT NULL), published_at, comments.id`,
      )
      .all(threadId) as Row[];
    return {
      threadId,
      video: videoDto(v, clock()),
      canReply: !!t.can_reply,
      comments: rows.map(commentDto),
      totalReplyCount: t.total_reply_count,
    };
  }

  function getComment(id: string): CommentDTO | null {
    const r = db
      .prepare(
        `SELECT comments.*, i.state, i.state_source, i.done_reason,
           (SELECT 1 FROM reply_posts rp WHERE rp.posted_comment_id = comments.id AND rp.status = 'posted') IS NOT NULL AS posted_by_app
         FROM comments JOIN items i ON i.id = comments.id WHERE comments.id = ?`,
      )
      .get(id) as Row | undefined;
    return r ? commentDto(r) : null;
  }

  function counts(): Counts {
    const at = now();
    const by = new Map<string, number>(
      (db.prepare('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all() as Row[]).map((r) => [r.state, r.n]),
    );
    const n = (s: string) => by.get(s) ?? 0;
    const snoozed = (
      db.prepare("SELECT COUNT(*) AS n FROM items WHERE state = 'inbox' AND snoozed_until > ?").get(at) as Row
    ).n as number;
    const bySource: Record<number, number> = {};
    for (const s of db.prepare('SELECT id FROM sources').all() as Row[]) bySource[s.id] = 0;
    for (const r of db
      .prepare(
        `SELECT sv.source_id, COUNT(*) AS n FROM items i JOIN source_videos sv ON sv.video_id = i.container_key
         WHERE i.provider = 'youtube' AND i.state = 'inbox' AND ${NOT_SNOOZED} GROUP BY sv.source_id`,
      )
      .all({ now: at }) as Row[]) {
      bySource[r.source_id] = r.n;
    }
    const byFeed: Record<number, number> = {};
    for (const f of db.prepare('SELECT id FROM feeds').all() as Row[]) byFeed[f.id] = 0;
    for (const r of db
      .prepare(
        `SELECT i.feed_id, COUNT(*) AS n FROM items i WHERE i.feed_id IS NOT NULL AND i.state = 'inbox'
           AND ${NOT_SNOOZED} GROUP BY i.feed_id`,
      )
      .all({ now: at }) as Row[]) {
      byFeed[r.feed_id] = r.n;
    }
    const todos = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM items i WHERE i.provider = 'todo' AND i.state = 'inbox' AND ${NOT_SNOOZED}`)
        .get({ now: at }) as Row
    ).n as number;
    const byRepo: Record<string, number> = {};
    for (const r of db
      .prepare(
        `SELECT i.container_key AS repo, COUNT(*) AS n FROM items i WHERE i.provider = 'github' AND i.state = 'inbox'
           AND ${NOT_SNOOZED} GROUP BY i.container_key`,
      )
      .all({ now: at }) as Row[]) {
      byRepo[r.repo] = r.n;
    }
    const all = [...by.entries()].reduce((a, [s, c]) => (s === 'own' ? a : a + c), 0);
    return {
      inbox: n('inbox') - snoozed,
      done: n('done') + n('replied') + n('auto_replied') + n('resolved'),
      all,
      snoozed,
      bySource,
      byFeed,
      byRepo,
      todos,
    };
  }

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
    listInbox,
    getThread,
    getComment,
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
    counts,
    ...createQuota({ db, now }),
  };
}

export function openRepo(path: string, clock?: () => Date): Repo {
  return createRepo(openDb(path), clock);
}
