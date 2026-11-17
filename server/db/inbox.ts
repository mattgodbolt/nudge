import type { InboxPage, InboxQuery } from '../../shared/api.js';
import { SNOOZE_BUCKETS, WAKE_CAUSES, isSnoozeBucket, wholeDays } from '../../shared/snooze.js';
import type { CommentDTO, Counts, DoneReason, InboxItem, SnoozeBucket, ThreadDetail } from '../../shared/types.js';
import { permalink } from '../../shared/youtube-urls.js';
import type { Repo } from '../contracts.js';
import type { Row } from './common.js';
import type { Db } from './db.js';
import { suggestionDto } from './suggestions.js';
import { VIDEO_SELECT, videoDto } from './youtube.js';

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

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type InboxStore = Pick<Repo, 'listInbox' | 'getThread' | 'getComment' | 'counts'>;

export interface InboxDeps {
  db: Db;
  clock: () => Date;
  now: () => string;
  /** The provider-neutral part of an inbox row (feeds.ts owns the GitHub and todo shapes). */
  itemFromRow: (r: Row) => InboxItem['item'];
}

/** Reading the inbox: the list and its paging, threads, single comments and the sidebar counts. */
export function createInbox(deps: InboxDeps): InboxStore {
  const { db, clock, now, itemFromRow } = deps;

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
    const item = itemFromRow(r);
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
        me: sg("sx.turn = 'me'"),
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

  return { listInbox, getThread, getComment, counts };
}
