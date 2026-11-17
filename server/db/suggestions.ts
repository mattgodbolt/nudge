import type { SuggestedAction, SuggestionDTO } from '../../shared/types.js';
import type { Category, Confidence, EvalItem, Turn, Verdict } from '../classify/types.js';
import type { Db } from './db.js';

/** The classifier's verdict as the action the owner sees. Deliberately the only place the two vocabularies meet. */
export const ACTION_OF: Record<Verdict, SuggestedAction> = {
  needs_reply: 'reply',
  needs_action: 'act',
  no_reply_needed: 'skip',
  spam: 'spam',
};

export interface SuggestionRow {
  itemId: string;
  stateKey: string;
  verdict: Verdict;
  category: Category;
  confidence: Confidence;
  reason: string;
  injectionAttempt: boolean;
  /** 'rules' when a deterministic rule decided and no model was called. */
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
  /** Whose move it is and what comes next, as judged from the thread; null for rules and for older rows. */
  turn?: Turn | null;
  nextStep?: string | null;
  /** The recent comments the model was shown, and the comment count they were fetched at (GitHub only). */
  thread?: RecentComment[] | null;
  threadCount?: number | null;
}

/** One of the last few comments on a GitHub item, trimmed for the model. */
export interface RecentComment {
  author: string;
  isOwner: boolean;
  text: string;
}

/** What the browser may see. A suspected injection attempt gets a warning and nothing else: never an action. */
export function suggestionDto(r: {
  verdict: Verdict;
  confidence: Confidence;
  reason: string;
  injection: boolean;
  turn?: string | null;
  nextStep?: string | null;
}): SuggestionDTO {
  if (r.injection) return { action: null, reason: '', confidence: 'low', suspicious: true };
  const turn = r.turn === 'me' || r.turn === 'them' || r.turn === 'nobody' ? r.turn : null;
  return {
    action: ACTION_OF[r.verdict],
    reason: r.reason,
    confidence: r.confidence,
    suspicious: false,
    turn,
    nextStep: r.nextStep || null,
  };
}

/** An inbox item as the worker needs it: the classifier's view of it, and the fingerprint stored for it, if any. */
export interface SuggestionCandidate {
  item: EvalItem;
  storedKey: string | null;
  /** GitHub only: where to fetch the recent comments from. */
  target?: { repo: string; number: number };
  /** GitHub only: the excerpt stored with the current suggestion, and the comment count it was fetched at. */
  storedThread?: { count: number; recent: RecentComment[] } | null;
}

export interface SuggestionStore {
  /** Insert or replace the item's one current suggestion. */
  save(row: SuggestionRow): void;
  /** Current suggestions as DTOs, for the given items (absent = none). */
  get(ids: string[]): Map<string, SuggestionDTO>;
  /**
   * Inbox items (not snoozed, not mine, YouTube or GitHub) as the classifier sees them: those with a conversation to
   * judge (any YouTube comment, a GitHub item with comments) first, then the rest, each group newest first. `ids`
   * narrows it to those items. At most `scan` items are looked at.
   */
  candidates(opts: { ids?: string[]; scan: number; myLogins: Set<string> }): SuggestionCandidate[];
  /**
   * How many inbox items can have a suggestion (the same set `candidates` draws from) and how many of them have a
   * current one: made by a rule, or by the given prompt version.
   */
  progress(promptVersion: string): { total: number; done: number };
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const cap = (s: string | null | undefined, n: number): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const THREAD_CONTEXT = 5;

function parseData(s: string | null): Row {
  try {
    const v = s ? JSON.parse(s) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function createSuggestions(db: Db, clock: () => Date = () => new Date()): SuggestionStore {
  // Prepared lazily: tests build repos around databases that are not at the latest version yet.
  function save(r: SuggestionRow): void {
    db.prepare(
      `INSERT OR REPLACE INTO suggestions (item_id, state_key, verdict, category, confidence, reason, injection_attempt,
         model, prompt_version, input_tokens, output_tokens, cost_usd, created_at, turn, next_step, thread, thread_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.itemId,
      r.stateKey,
      r.verdict,
      r.category,
      r.confidence,
      r.reason,
      r.injectionAttempt ? 1 : 0,
      r.model,
      r.promptVersion,
      r.inputTokens,
      r.outputTokens,
      r.costUsd,
      r.createdAt,
      r.turn ?? null,
      r.nextStep ?? null,
      r.thread ? JSON.stringify(r.thread) : null,
      r.threadCount ?? null,
    );
  }

  function get(ids: string[]): Map<string, SuggestionDTO> {
    const out = new Map<string, SuggestionDTO>();
    if (ids.length === 0) return out;
    for (const r of db
      .prepare(
        `SELECT item_id, verdict, confidence, reason, injection_attempt, turn, next_step FROM suggestions
          WHERE item_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as Row[]) {
      out.set(
        r.item_id,
        suggestionDto({ ...(r as any), injection: !!r.injection_attempt, nextStep: r.next_step }), // eslint-disable-line @typescript-eslint/no-explicit-any
      );
    }
    return out;
  }

  function candidates(opts: { ids?: string[]; scan: number; myLogins: Set<string> }): SuggestionCandidate[] {
    const at = clock().toISOString();
    const rows = db
      .prepare(
        `SELECT i.id, i.provider, i.kind, i.container_key, i.container_title, i.title, i.author, i.body_plain,
                i.occurred_at, i.source_state, i.reason, i.data, i.state, i.state_source,
                c.thread_id, c.parent_id, v.channel_title,
                EXISTS (SELECT 1 FROM sources s WHERE s.kind = 'channel' AND s.is_own = 1 AND s.yt_id = v.channel_id)
                  AS own_channel,
                s.state_key AS stored_key, s.thread AS stored_thread, s.thread_count AS stored_thread_count,
                i.snooze_why, i.woke_at, i.snooze_bucket, i.snooze_until_activity, i.snooze_wake_cause
           FROM items i
           LEFT JOIN comments c ON c.id = i.id
           LEFT JOIN videos v ON i.provider = 'youtube' AND v.id = i.container_key
           LEFT JOIN suggestions s ON s.item_id = i.id
          WHERE i.state = 'inbox' AND i.is_own = 0 AND i.provider IN ('youtube', 'github')
            AND (i.snoozed_until IS NULL OR i.snoozed_until <= @at)
            ${opts.ids ? 'AND i.id IN (SELECT value FROM json_each(@ids))' : ''}
          ORDER BY CASE WHEN i.provider = 'youtube' THEN 0
                        WHEN CASE WHEN json_valid(i.data) THEN COALESCE(json_extract(i.data, '$.comments'), 0) ELSE 0 END > 0
                        THEN 0 ELSE 1 END,
                   COALESCE(i.woke_at, i.occurred_at) DESC, i.id LIMIT @scan`,
      )
      .all({ at, scan: opts.scan, ...(opts.ids ? { ids: JSON.stringify(opts.ids) } : {}) }) as Row[];

    const threadStmt = db.prepare(
      'SELECT id, is_own, text_plain FROM comments WHERE thread_id = ? ORDER BY published_at, id',
    );
    const notesStmt = db.prepare(
      "SELECT text FROM notes WHERE item_id = ? AND scope = 'item' AND enabled = 1 ORDER BY id DESC LIMIT 3",
    );
    return rows.map((r): SuggestionCandidate => {
      const ownerNotes = (notesStmt.all(r.id) as { text: string }[]).map((n) => n.text);
      // Only an item that came back from a snooze: an old note on one that was never snoozed again is not news.
      const note =
        typeof r.snooze_why === 'string' && r.snooze_why && r.woke_at ? { snoozeNote: cap(r.snooze_why, 200) } : {};
      // The bucket rides along with the note, or alone when the owner gave no words.
      const bucket = r.woke_at && typeof r.snooze_bucket === 'string' ? r.snooze_bucket : null;
      const waited = !!r.woke_at && r.snooze_until_activity === 1;
      const snooze =
        bucket || waited
          ? {
              snooze: {
                bucket,
                untilActivity: waited,
                wokeBy:
                  r.snooze_wake_cause === 'activity' || r.snooze_wake_cause === 'fallback' ? r.snooze_wake_cause : null,
              },
            }
          : {};
      const extra = { ...note, ...snooze, ...(ownerNotes.length ? { ownerNotes } : {}) };
      const base = {
        ...extra,
        id: r.id as string,
        kind: r.kind as string,
        container: cap(r.container_title ?? r.container_key, 140),
        title: r.title ? cap(r.title, 200) : null,
        author: (r.author as string | null) ?? null,
        text: cap(r.body_plain, 1500),
        occurredAt: r.occurred_at as string,
        state: r.state as string,
        stateSource: r.state_source as string,
      };
      if (r.provider === 'youtube') {
        const t = r.thread_id ? (threadStmt.all(r.thread_id) as Row[]) : [];
        const me = t.findIndex((x) => x.id === r.id);
        const before = me < 0 ? [] : t.slice(Math.max(0, me - THREAD_CONTEXT), me);
        return {
          storedKey: r.stored_key ?? null,
          item: {
            ...base,
            provider: 'youtube',
            channel: cap(r.channel_title, 80) || null,
            ownChannel: !!r.own_channel,
            isReply: !!r.parent_id,
            thread: before.map((x) => ({ own: !!x.is_own, text: cap(x.text_plain, 300) })),
          },
        };
      }
      const d = parseData(r.data);
      const comments = typeof d.comments === 'number' ? d.comments : 0;
      let stored: unknown = null;
      try {
        stored = r.stored_thread ? JSON.parse(r.stored_thread) : null;
      } catch {
        // unreadable excerpt: treated as none, so it is fetched again
      }
      const storedThread =
        Array.isArray(stored) && typeof r.stored_thread_count === 'number'
          ? { count: r.stored_thread_count as number, recent: stored as RecentComment[] }
          : null;
      const last = typeof d.lastCommenter === 'string' && d.lastCommenter ? d.lastCommenter : null;
      return {
        storedKey: r.stored_key ?? null,
        storedThread,
        ...(comments > 0 && typeof d.number === 'number' && r.container_key
          ? { target: { repo: r.container_key as string, number: d.number } }
          : {}),
        item: {
          ...base,
          provider: 'github',
          github: {
            association: d.association ?? null,
            authorType: d.authorType ?? null,
            labels: Array.isArray(d.labels) ? d.labels : [],
            comments,
            draft: !!d.draft,
            sourceState: r.source_state ?? null,
            reason: r.reason ?? null,
            // Already stored by the poller when the comment count grew: no extra GitHub call is ever made for this.
            ...(last ? { lastCommenter: last, lastCommenterIsMe: opts.myLogins.has(last.toLowerCase()) } : {}),
          },
        },
      };
    });
  }

  function progress(promptVersion: string): { total: number; done: number } {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(s.item_id IS NOT NULL AND (s.model = 'rules' OR s.prompt_version = @pv)), 0) AS done
           FROM items i LEFT JOIN suggestions s ON s.item_id = i.id
          WHERE i.state = 'inbox' AND i.is_own = 0 AND i.provider IN ('youtube', 'github')
            AND (i.snoozed_until IS NULL OR i.snoozed_until <= @at)`,
      )
      .get({ pv: promptVersion, at: clock().toISOString() }) as { total: number; done: number };
    return r;
  }

  return { save, get, candidates, progress };
}
