import type {
  CommentState,
  FeedDTO,
  GithubAssociation,
  ImportMode,
  ItemDTO,
  MuteKind,
  MuteRuleDTO,
} from '../../shared/types.js';
import type { Db } from './db.js';
import type { Events } from './events.js';
import { wakeOnActivity } from './wake.js';
import type { FeedPollResult, FeedRow, GithubItemUpsert, NewFeed, UpsertGithubResult } from '../contracts.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EPOCH = '1970-01-01T00:00:00.000Z';
/** States a GitHub item leaves when someone other than the owner comments on it while it is open. */
export const DONE_LIKE: ReadonlySet<string> = new Set(['done', 'replied', 'resolved']);
const MUTE_KINDS: readonly MuteKind[] = ['repo', 'owner', 'author', 'bots', 'item'];

export const githubItemId = (owner: string, repo: string, number: number): string => `gh:${owner}/${repo}#${number}`;

/** The columns that make an item's "muted" status, so the same predicate serves ingest and retroactive application. */
const MUTED_SQL = `(
  i.container_key IN (SELECT value FROM mute_rules WHERE kind = 'repo')
  OR lower(substr(i.container_key, 1, instr(i.container_key, '/') - 1))
       IN (SELECT lower(value) FROM mute_rules WHERE kind = 'owner')
  OR lower(i.author) IN (SELECT lower(value) FROM mute_rules WHERE kind = 'author')
  OR (EXISTS (SELECT 1 FROM mute_rules WHERE kind = 'bots') AND json_extract(i.data, '$.authorType') = 'Bot')
  OR i.id IN (SELECT value FROM mute_rules WHERE kind = 'item'))`;

export interface FeedsDeps {
  db: Db;
  now: () => string;
  events: Events;
  /** Logins that are me, lower-cased. */
  myAccounts: () => Set<string>;
  baselineFor: (mode: ImportMode) => string;
}

export function createFeedsRepo(deps: FeedsDeps) {
  const { db, now, events: ev } = deps;

  const feedRow = (r: Row): FeedRow => ({
    id: r.id,
    provider: r.provider,
    owner: r.owner,
    kind: r.kind === 'repo' ? 'repo' : 'owner',
    ownerType: r.owner_type,
    prs: !!r.prs,
    issues: !!r.issues,
    enabled: !!r.enabled,
    importMode: r.import_mode,
    addedAt: r.added_at,
    baselineAt: r.baseline_at,
    cursor: r.cursor,
    lastPolledAt: r.last_polled_at,
    nextPollAt: r.next_poll_at,
    errorCount: r.error_count,
    backoffUntil: r.backoff_until,
    lastError: r.last_error,
    rate:
      r.rate_limit != null && r.rate_remaining != null && r.rate_reset_at
        ? { limit: r.rate_limit, remaining: r.rate_remaining, resetAt: r.rate_reset_at }
        : null,
  });

  function feedDto(r: Row): FeedDTO {
    const f = feedRow(r);
    return {
      id: f.id,
      provider: f.provider,
      owner: f.owner,
      kind: f.kind,
      ownerType: f.ownerType,
      prs: f.prs,
      issues: f.issues,
      enabled: f.enabled,
      importMode: f.importMode,
      addedAt: f.addedAt,
      lastPolledAt: f.lastPolledAt,
      nextPollAt: f.nextPollAt,
      lastError: f.lastError,
      rate: f.rate,
      inboxCount: r.inbox_count ?? 0,
      itemCount: r.item_count ?? 0,
    };
  }

  const FEED_SELECT = `SELECT f.*,
      (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.state = 'inbox'
         AND (i.snoozed_until IS NULL OR i.snoozed_until <= @now)) AS inbox_count,
      (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id) AS item_count
    FROM feeds f`;

  const listFeeds = (): FeedDTO[] =>
    (db.prepare(`${FEED_SELECT} ORDER BY f.id`).all({ now: now() }) as Row[]).map(feedDto);
  const getFeed = (id: number): FeedDTO | null => {
    const r = db.prepare(`${FEED_SELECT} WHERE f.id = @id`).get({ now: now(), id }) as Row | undefined;
    return r ? feedDto(r) : null;
  };
  const getFeedRow = (id: number): FeedRow | null => {
    const r = db.prepare('SELECT * FROM feeds WHERE id = ?').get(id) as Row | undefined;
    return r ? feedRow(r) : null;
  };
  const enabledFeedRows = (): FeedRow[] =>
    (db.prepare('SELECT * FROM feeds WHERE enabled = 1 ORDER BY id').all() as Row[]).map(feedRow);

  function addFeed(f: NewFeed): FeedDTO {
    const owner = f.owner.trim();
    const kind = owner.includes('/') ? 'repo' : 'owner';
    const at = now();
    return db.transaction(() => {
      const res = db
        .prepare(
          `INSERT INTO feeds (provider, kind, owner, prs, issues, import_mode, added_at, baseline_at, next_poll_at)
           VALUES ('github', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, owner, f.prs ? 1 : 0, f.issues ? 1 : 0, f.importMode, at, deps.baselineFor(f.importMode), at);
      const id = Number(res.lastInsertRowid);
      // An owner feed takes over items its repo feeds already hold, so removing a repo feed later cannot take them.
      if (kind === 'owner') {
        db.prepare(
          `UPDATE items SET feed_id = ? WHERE provider = 'github'
             AND lower(substr(container_key, 1, instr(container_key, '/') - 1)) = lower(?)
             AND feed_id IN (SELECT id FROM feeds WHERE kind = 'repo')`,
        ).run(id, owner);
      }
      return getFeed(id)!;
    })();
  }

  function updateFeed(
    id: number,
    p: Partial<{ enabled: boolean; prs: boolean; issues: boolean; importMode: ImportMode }>,
  ): FeedDTO | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (p.enabled !== undefined) (sets.push('enabled = ?'), args.push(p.enabled ? 1 : 0));
    if (p.prs !== undefined) (sets.push('prs = ?'), args.push(p.prs ? 1 : 0));
    if (p.issues !== undefined) (sets.push('issues = ?'), args.push(p.issues ? 1 : 0));
    if (p.importMode !== undefined) (sets.push('import_mode = ?'), args.push(p.importMode));
    if (sets.length) db.prepare(`UPDATE feeds SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return getFeed(id);
  }

  /**
   * Items belong to one feed, and deleting a feed deletes its items (ON DELETE CASCADE). An item that two feeds cover
   * (a repo feed under an owner feed) belongs to the owner feed, the broader one. So deleting a repo feed never takes
   * anything the owner feed also covers; and deleting the owner feed first hands each repo's items to that repo's own
   * feed, if it has one, rather than losing them.
   */
  function deleteFeed(id: number): boolean {
    return db.transaction(() => {
      const f = db.prepare('SELECT kind, owner FROM feeds WHERE id = ?').get(id) as Row | undefined;
      if (f?.kind === 'owner') {
        db.prepare(
          `UPDATE items SET feed_id = (SELECT r.id FROM feeds r WHERE r.kind = 'repo' AND lower(r.owner) = lower(items.container_key))
           WHERE feed_id = ? AND lower(container_key) IN (SELECT lower(owner) FROM feeds WHERE kind = 'repo')`,
        ).run(id);
      }
      return db.prepare('DELETE FROM feeds WHERE id = ?').run(id).changes > 0;
    })();
  }

  function recordFeedPoll(id: number, r: FeedPollResult): void {
    db.prepare(
      `UPDATE feeds SET
         cursor = COALESCE(?, cursor), owner_type = COALESCE(?, owner_type), last_polled_at = ?, next_poll_at = ?,
         error_count = ?, backoff_until = ?, last_error = ?,
         rate_limit = COALESCE(?, rate_limit), rate_remaining = COALESCE(?, rate_remaining),
         rate_reset_at = COALESCE(?, rate_reset_at)
       WHERE id = ?`,
    ).run(
      r.cursor ?? null,
      r.ownerType ?? null,
      now(),
      r.nextPollAt,
      r.errorCount,
      r.backoffUntil ?? null,
      r.error ?? null,
      r.rate?.limit ?? null,
      r.rate?.remaining ?? null,
      r.rate?.resetAt ?? null,
      id,
    );
  }

  /* ---------------- mute rules ---------------- */
  const muteDto = (r: Row): MuteRuleDTO => ({ id: r.id, kind: r.kind, value: r.value, createdAt: r.created_at });
  const listMuteRules = (): MuteRuleDTO[] =>
    (db.prepare('SELECT * FROM mute_rules ORDER BY id').all() as Row[]).map(muteDto);

  /**
   * A rule usually covers many items, so the event belongs to the rule: item_id is the item for `item` rules and ''
   * otherwise. Items archived by a new rule get their own `state` events from the triage call that follows it.
   */
  const muteEvent = (kind: 'mute' | 'unmute', rule: MuteRuleDTO, extra: Record<string, unknown> = {}) => ({
    itemId: rule.kind === 'item' ? rule.value : '',
    at: now(),
    kind,
    source: 'user' as const,
    meta: { ruleId: rule.id, ruleKind: rule.kind, value: rule.value, ...extra },
  });

  /** Recompute the cached muted flag after rules change. */
  function recomputeMuted(): void {
    db.prepare(
      `UPDATE items AS i SET muted = CASE WHEN ${MUTED_SQL} THEN 1 ELSE 0 END WHERE i.provider = 'github'`,
    ).run();
  }

  /** Items in the inbox that a rule covers (so a new rule can archive them straight away). */
  function inboxIdsMuted(): string[] {
    return (
      db
        .prepare("SELECT i.id FROM items i WHERE i.provider = 'github' AND i.state = 'inbox' AND i.muted = 1")
        .all() as Row[]
    ).map((r) => r.id as string);
  }

  function addMuteRule(kind: MuteKind, value: string): { rule: MuteRuleDTO; affectedIds: string[] } {
    if (!MUTE_KINDS.includes(kind)) throw new Error(`Unknown mute kind ${kind}`);
    const v = kind === 'bots' ? '' : value.trim();
    return db.transaction(() => {
      const inserted =
        db.prepare('INSERT OR IGNORE INTO mute_rules (kind, value, created_at) VALUES (?, ?, ?)').run(kind, v, now())
          .changes > 0;
      const rule = muteDto(db.prepare('SELECT * FROM mute_rules WHERE kind = ? AND value = ?').get(kind, v) as Row);
      recomputeMuted();
      const affectedIds = inboxIdsMuted();
      // Re-adding an existing rule is a no-op, so it is not a decision worth recording.
      if (inserted) ev.record(muteEvent('mute', rule, { affected: affectedIds.length }));
      return { rule, affectedIds };
    })();
  }

  function deleteMuteRule(id: number): boolean {
    return db.transaction(() => {
      const rule = db.prepare('SELECT * FROM mute_rules WHERE id = ?').get(id) as Row | undefined;
      const gone = db.prepare('DELETE FROM mute_rules WHERE id = ?').run(id).changes > 0;
      if (gone) {
        recomputeMuted();
        if (rule) ev.record(muteEvent('unmute', muteDto(rule)));
      }
      return gone;
    })();
  }

  /* ---------------- items ---------------- */
  /** The provider-neutral card for one item (any provider), or null. */
  function itemFromRow(r: Row): ItemDTO {
    const data = parseData(r.data);
    const github = r.provider === 'github';
    const [owner = '', repo = ''] = (r.container_key ?? '').split('/');
    return {
      id: r.item_id ?? r.id,
      provider: r.provider,
      kind: r.kind,
      title: r.i_title ?? r.title ?? null,
      author: r.i_author ?? r.author ?? null,
      authorAvatarUrl: r.i_avatar ?? r.author_avatar_url ?? null,
      isOwn: !!(r.i_own ?? r.is_own),
      url: github ? (r.i_url ?? r.url ?? null) : null,
      containerKey: r.container_key ?? null,
      containerTitle: r.container_title ?? null,
      containerUrl: github && r.container_key ? `https://github.com/${r.container_key}` : null,
      sourceState: r.source_state ?? null,
      reason: r.reason ?? null,
      muted: !!r.muted,
      ...(r.provider === 'todo' ? { todo: { raw: typeof data.raw === 'string' ? data.raw : '' } } : {}),
      ...(github
        ? {
            github: {
              owner,
              repo,
              number: data.number ?? 0,
              draft: !!data.draft,
              association: (data.association ?? null) as GithubAssociation | null,
              authorType: data.authorType ?? null,
              comments: data.comments ?? 0,
              labels: Array.isArray(data.labels) ? data.labels : [],
              createdAt: data.createdAt ?? r.occurred_at,
              ...(r.reason === 'new_activity'
                ? { lastCommenter: data.lastCommenter ?? null, activitySince: data.activitySince ?? null }
                : {}),
            },
          }
        : {}),
    };
  }

  function getItem(id: string): { item: ItemDTO; state: CommentState; occurredAt: string; bodyPlain: string } | null {
    const r = db.prepare('SELECT *, id AS item_id FROM items WHERE id = ?').get(id) as Row | undefined;
    return r ? { item: itemFromRow(r), state: r.state, occurredAt: r.occurred_at, bodyPlain: r.body_plain } : null;
  }

  type ItemMeta = {
    state: CommentState;
    sourceState: string | null;
    comments: number;
    snoozedUntilActivity: boolean;
    seenUpdatedAt: string | null;
  };
  function githubItemMeta(ids: string[]): Map<string, ItemMeta> {
    const out = new Map<string, ItemMeta>();
    if (ids.length === 0) return out;
    for (const r of db
      .prepare(
        `SELECT id, state, source_state, data, snooze_until_activity, snoozed_until FROM items WHERE provider = 'github'
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as Row[]) {
      out.set(r.id, {
        state: r.state,
        sourceState: r.source_state,
        comments: parseData(r.data).comments ?? 0,
        seenUpdatedAt: seenUpdatedAt(parseData(r.data)),
        snoozedUntilActivity: r.snooze_until_activity === 1 && !!r.snoozed_until && r.snoozed_until > now(),
      });
    }
    return out;
  }

  /**
   * Insert or refresh GitHub items from one poll. The rules that matter:
   *  - new items arrive in the inbox, unless they are mine ('own'), older than the feed's baseline ('archived'),
   *    already closed ('resolved') or covered by a mute rule ('archived');
   *  - closing or merging at GitHub resolves an inbox item (never one the user put there);
   *  - something Done/resolved comes back when someone other than me comments on it (or, for a PR, reviews it)
   *    while it is open, and when it is reopened at GitHub, unless muted.
   */
  function upsertGithubItems(feedId: number, ups: GithubItemUpsert[]): UpsertGithubResult {
    const mine = deps.myAccounts();
    const feed = db.prepare('SELECT baseline_at, kind FROM feeds WHERE id = ?').get(feedId) as Row | undefined;
    const baseline: string = feed?.baseline_at ?? EPOCH;
    // A repo feed's items belong to the owner feed when there is one (see deleteFeed).
    const ownerFeedFor = db.prepare("SELECT id FROM feeds WHERE kind = 'owner' AND lower(owner) = lower(?)");
    const owningFeed = (container: string): number => {
      if (feed?.kind !== 'repo') return feedId;
      const o = ownerFeedFor.get(container.split('/')[0]!) as Row | undefined;
      return o ? o.id : feedId;
    };
    const feedKind = db.prepare('SELECT kind FROM feeds WHERE id = ?');
    const repoint = db.prepare('UPDATE items SET feed_id = ? WHERE id = ?');
    const rules = listMuteRules();
    const muteHit = (u: GithubItemUpsert): boolean =>
      rules.some(
        (r) =>
          (r.kind === 'repo' && r.value === u.repo) ||
          (r.kind === 'owner' && r.value.toLowerCase() === u.repo.split('/')[0]!.toLowerCase()) ||
          (r.kind === 'author' && r.value.toLowerCase() === u.author.toLowerCase()) ||
          (r.kind === 'bots' && u.authorType === 'Bot') ||
          (r.kind === 'item' && r.value === u.id),
      );
    const res: UpsertGithubResult = { added: [], reopened: [], woken: [], changed: [] };
    const at = now();
    const get = db.prepare(
      'SELECT state, state_source, source_state, snoozed_until, snooze_until_activity, data, feed_id FROM items WHERE id = ?',
    );
    const insert = db.prepare(
      `INSERT INTO items (id, provider, kind, feed_id, container_key, container_title, title, author, author_avatar_url,
         is_own, body_plain, url, occurred_at, source_state, reason, data, muted, state, state_source,
         state_changed_at, first_seen_at)
       VALUES (@id, 'github', @kind, @feedId, @repo, @repo, @title, @author, @avatar, @isOwn, @body, @url, @createdAt,
         @sourceState, @reason, @data, @muted, @state, @stateSource, @at, @at)`,
    );
    const refresh = db.prepare(
      `UPDATE items SET title = @title, body_plain = @body, author_avatar_url = @avatar, is_own = @isOwn,
         source_state = @sourceState, data = @data, muted = @muted WHERE id = @id`,
    );
    const move = db.prepare(
      `UPDATE items SET state = @state, state_source = 'sync', state_changed_at = @at, reason = @reason,
         woke_at = @woke, snoozed_until = NULL, snooze_until_activity = 0 WHERE id = @id`,
    );
    // Everything here comes from the remote service, so the source is 'sync' (a mute rule only blocks the reopen).
    const moveTo = (existing: Row, id: string, to: CommentState, reason: string | null, woke: string | null): void => {
      move.run({ id, state: to, at, reason, woke });
      ev.record({
        itemId: id,
        at,
        kind: 'state',
        from: existing.state,
        to,
        source: 'sync',
        meta: { reason: reason ?? 'closed_upstream' },
      });
      // The move also drops any snooze.
      if (existing.snoozed_until) {
        ev.record({
          itemId: id,
          at,
          kind: 'snooze',
          from: existing.snoozed_until,
          to: null,
          source: 'sync',
          meta: { reason: reason ?? 'closed_upstream' },
        });
      }
    };
    db.transaction(() => {
      for (const u of ups) {
        const isMine = mine.has(u.author.toLowerCase());
        const muted = muteHit(u);
        const existing = get.get(u.id) as Row | undefined;
        const prev = existing ? parseData(existing.data) : {};
        // Parked until someone else acts: the poll below decides whether that just happened.
        const waiting =
          !!existing &&
          existing.state === 'inbox' &&
          existing.snooze_until_activity === 1 &&
          !!existing.snoozed_until &&
          existing.snoozed_until > at;
        const counted = !!existing && u.comments > (prev.comments ?? 0);
        // Whether the newest comment is mine decides what happens to a Done or parked item. When the poller could not
        // find out (a failed lookup, or past its per-poll cap) the growth is not taken in at all: the stored count stays
        // where it was, so the next poll sees the same growth and asks again. Treating "unknown" as "someone else"
        // would bring the owner's items back on their own comments.
        const unknown =
          counted &&
          u.sourceState === 'open' &&
          u.lastCommenterIsMe === undefined &&
          (DONE_LIKE.has(existing.state) || waiting);
        const grew = counted && !unknown;
        // Reviews and inline review comments do not move the comment count, so a PR that moved while Done or parked
        // carries the poller's answer about them (see GithubItemUpsert.reviewer). A newest comment from someone else
        // decides it already, so the poller does not ask then. Unknown is handled like an unknown commenter: the last
        // seen update is kept so the next poll asks again from the same point.
        const seen = existing ? seenUpdatedAt(prev) : null;
        const reviewDue =
          !!existing &&
          u.kind === 'pr' &&
          u.sourceState === 'open' &&
          (DONE_LIKE.has(existing.state) || waiting) &&
          seen !== null &&
          u.updatedAt > seen &&
          u.lastCommenterIsMe !== false;
        const reviewUnknown = reviewDue && u.reviewer === undefined;
        const reviewed = reviewDue && typeof u.reviewer === 'string';
        const data = JSON.stringify({
          // The newest commenter is only known when the poller looked it up for this very growth.
          lastCommenter: reviewed ? u.reviewer : (u.lastCommenter ?? (grew ? undefined : prev.lastCommenter)),
          // Comments after the last poll that saw the old count are the ones that bring a Done item back. Kept while
          // the item sits in the inbox so a second reply does not hide the first.
          checkedAt: unknown || reviewUnknown ? (prev.checkedAt ?? at) : at,
          activitySince:
            (grew || reviewed) && (existing.state !== 'inbox' || waiting)
              ? (prev.checkedAt ?? null)
              : (prev.activitySince ?? null),
          updatedAt: reviewUnknown ? seen : u.updatedAt,
          number: u.number,
          draft: u.draft,
          association: u.association,
          authorType: u.authorType,
          comments: unknown ? prev.comments : u.comments,
          labels: u.labels,
          createdAt: u.createdAt,
        });
        const common = {
          id: u.id,
          title: u.title,
          author: u.author,
          avatar: u.authorAvatarUrl,
          isOwn: isMine ? 1 : 0,
          body: u.bodyPlain,
          url: u.url,
          sourceState: u.sourceState,
          data,
          muted: muted ? 1 : 0,
          at,
        };
        if (!existing) {
          let state: CommentState = 'inbox';
          let reason: string | null = 'new';
          let stateSource = 'sync';
          if (isMine) [state, reason] = ['own', null];
          else if (muted) [state, reason, stateSource] = ['archived', 'muted', 'auto'];
          else if (u.createdAt < baseline) [state, reason] = ['archived', null];
          else if (u.sourceState !== 'open') [state, reason] = ['resolved', null];
          insert.run({
            ...common,
            kind: u.kind,
            feedId: owningFeed(u.repo),
            repo: u.repo,
            createdAt: u.createdAt,
            reason,
            state,
            stateSource,
          });
          if (state === 'inbox') res.added.push(u.id);
          continue;
        }
        refresh.run(common);
        const owning = owningFeed(u.repo);
        if (existing.feed_id !== owning && (feedKind.get(existing.feed_id) as Row | undefined)?.kind === 'repo') {
          repoint.run(owning, u.id);
        }
        // My own comment on a thread is a reply made on GitHub; the first poll that sees the count grow with me as
        // the newest commenter is the closest we get to when it happened.
        if (grew && u.lastCommenterIsMe === true) {
          ev.record({ itemId: u.id, at, kind: 'reply', source: 'sync', meta: { commenter: u.lastCommenter ?? null } });
        }
        const wasOpen = existing.source_state === 'open';
        const state: CommentState = existing.state;
        if (isMine || muted) {
          if (u.sourceState !== 'open' && state === 'inbox' && existing.state_source !== 'user') {
            moveTo(existing, u.id, 'resolved', null, null);
          }
          res.changed.push(u.id);
          continue;
        }
        // Someone other than me commented (or it was closed or merged) while it was parked until activity: it comes
        // back. A comment from me does not count. Also drops the "no activity" mark from an item that already came back.
        const commented = grew && u.lastCommenterIsMe !== true;
        const theirs = commented || reviewed;
        if (waiting && (theirs || (wasOpen && u.sourceState !== 'open'))) {
          const closed = wasOpen && u.sourceState !== 'open';
          const trigger = closed ? u.sourceState : commented ? 'comment' : 'review';
          const woken = wakeOnActivity(db, ev, [u.id], at, { trigger }, closed);
          if (woken.length > 0) res.woken.push(u.id);
          res.changed.push(u.id);
          continue;
        }
        if (theirs) wakeOnActivity(db, ev, [u.id], at);
        if (u.sourceState !== 'open' && state === 'inbox' && existing.state_source !== 'user') {
          moveTo(existing, u.id, 'resolved', null, null);
        } else if (u.sourceState === 'open' && state === 'resolved' && !wasOpen) {
          moveTo(existing, u.id, 'inbox', 'reopened', at);
          res.reopened.push(u.id);
        } else if (u.sourceState === 'open' && DONE_LIKE.has(state) && theirs) {
          moveTo(existing, u.id, 'inbox', 'new_activity', at);
          res.reopened.push(u.id);
        }
        res.changed.push(u.id);
      }
    })();
    return res;
  }

  /** "Me" changed (a login added or removed): re-derive is_own and move items in or out of the 'own' state. */
  function recomputeGithubOwnership(): void {
    const mine = JSON.stringify([...deps.myAccounts()]);
    const at = now();
    db.transaction(() => {
      db.prepare(
        "UPDATE items SET is_own = CASE WHEN lower(author) IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END WHERE provider = 'github'",
      ).run(mine);
      const meta = { reason: 'ownership_changed' };
      ev.recordStateMoves(
        "provider = 'github' AND is_own = 1 AND state != 'own' AND state_source != 'user'",
        [],
        "'own'",
        'sync',
        at,
        meta,
      );
      db.prepare(
        `UPDATE items SET state = 'own', state_source = 'sync', state_changed_at = ?
         WHERE provider = 'github' AND is_own = 1 AND state != 'own' AND state_source != 'user'`,
      ).run(at);
      ev.recordStateMoves(
        "provider = 'github' AND is_own = 0 AND state = 'own'",
        [],
        "CASE WHEN source_state = 'open' THEN 'inbox' ELSE 'resolved' END",
        'sync',
        at,
        meta,
      );
      db.prepare(
        `UPDATE items SET state_source = 'sync', state_changed_at = ?,
           state = CASE WHEN source_state = 'open' THEN 'inbox' ELSE 'resolved' END
         WHERE provider = 'github' AND is_own = 0 AND state = 'own'`,
      ).run(at);
    })();
  }

  return {
    recomputeGithubOwnership,
    listFeeds,
    getFeed,
    getFeedRow,
    enabledFeedRows,
    addFeed,
    updateFeed,
    deleteFeed,
    recordFeedPoll,
    listMuteRules,
    addMuteRule,
    deleteMuteRule,
    getItem,
    githubItemMeta,
    upsertGithubItems,
    itemFromRow,
  };
}

/**
 * The item's updated_at as of the last poll that took it in fully. Rows stored before it was kept fall back to when
 * that poll ran, which is no earlier than the update it saw.
 */
function seenUpdatedAt(data: Row): string | null {
  const v = data.updatedAt ?? data.checkedAt;
  return typeof v === 'string' ? v : null;
}

export function parseData(s: unknown): Row {
  if (typeof s !== 'string' || !s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Row) : {};
  } catch {
    return {};
  }
}
