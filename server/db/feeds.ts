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
import type { FeedPollResult, FeedRow, GithubItemUpsert, NewFeed, UpsertGithubResult } from '../contracts.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EPOCH = '1970-01-01T00:00:00.000Z';
const MUTE_KINDS: readonly MuteKind[] = ['repo', 'author', 'bots', 'item'];

export const githubItemId = (owner: string, repo: string, number: number): string => `gh:${owner}/${repo}#${number}`;

/** The columns that make an item's "muted" status, so the same predicate serves ingest and retroactive application. */
const MUTED_SQL = `(
  i.container_key IN (SELECT value FROM mute_rules WHERE kind = 'repo')
  OR lower(i.author) IN (SELECT lower(value) FROM mute_rules WHERE kind = 'author')
  OR (EXISTS (SELECT 1 FROM mute_rules WHERE kind = 'bots') AND json_extract(i.data, '$.authorType') = 'Bot')
  OR i.id IN (SELECT value FROM mute_rules WHERE kind = 'item'))`;

export interface FeedsDeps {
  db: Db;
  now: () => string;
  /** Logins that are me, lower-cased. */
  myAccounts: () => Set<string>;
  baselineFor: (mode: ImportMode) => string;
}

export function createFeedsRepo(deps: FeedsDeps) {
  const { db, now } = deps;

  const feedRow = (r: Row): FeedRow => ({
    id: r.id,
    provider: r.provider,
    owner: r.owner,
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
    const at = now();
    const res = db
      .prepare(
        `INSERT INTO feeds (provider, owner, prs, issues, import_mode, added_at, baseline_at, next_poll_at)
         VALUES ('github', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(owner, f.prs ? 1 : 0, f.issues ? 1 : 0, f.importMode, at, deps.baselineFor(f.importMode), at);
    return getFeed(Number(res.lastInsertRowid))!;
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

  const deleteFeed = (id: number): boolean => db.prepare('DELETE FROM feeds WHERE id = ?').run(id).changes > 0;

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
      db.prepare('INSERT OR IGNORE INTO mute_rules (kind, value, created_at) VALUES (?, ?, ?)').run(kind, v, now());
      const rule = muteDto(db.prepare('SELECT * FROM mute_rules WHERE kind = ? AND value = ?').get(kind, v) as Row);
      recomputeMuted();
      return { rule, affectedIds: inboxIdsMuted() };
    })();
  }

  function deleteMuteRule(id: number): boolean {
    return db.transaction(() => {
      const gone = db.prepare('DELETE FROM mute_rules WHERE id = ?').run(id).changes > 0;
      if (gone) recomputeMuted();
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
            },
          }
        : {}),
    };
  }

  function getItem(id: string): { item: ItemDTO; state: CommentState; occurredAt: string; bodyPlain: string } | null {
    const r = db.prepare('SELECT *, id AS item_id FROM items WHERE id = ?').get(id) as Row | undefined;
    return r ? { item: itemFromRow(r), state: r.state, occurredAt: r.occurred_at, bodyPlain: r.body_plain } : null;
  }

  function githubItemMeta(
    ids: string[],
  ): Map<string, { state: CommentState; sourceState: string | null; comments: number }> {
    const out = new Map<string, { state: CommentState; sourceState: string | null; comments: number }>();
    if (ids.length === 0) return out;
    for (const r of db
      .prepare(
        `SELECT id, state, source_state, data FROM items WHERE provider = 'github'
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as Row[]) {
      out.set(r.id, { state: r.state, sourceState: r.source_state, comments: parseData(r.data).comments ?? 0 });
    }
    return out;
  }

  /**
   * Insert or refresh GitHub items from one poll. The rules that matter:
   *  - new items arrive in the inbox, unless they are mine ('own'), older than the feed's baseline ('archived'),
   *    already closed ('resolved') or covered by a mute rule ('archived');
   *  - closing or merging at GitHub resolves an inbox item (never one the user put there);
   *  - something Done/resolved comes back when someone other than me comments on it while it is open, and when
   *    it is reopened at GitHub, unless muted.
   */
  function upsertGithubItems(feedId: number, ups: GithubItemUpsert[]): UpsertGithubResult {
    const mine = deps.myAccounts();
    const feed = db.prepare('SELECT baseline_at FROM feeds WHERE id = ?').get(feedId) as Row | undefined;
    const baseline: string = feed?.baseline_at ?? EPOCH;
    const rules = listMuteRules();
    const muteHit = (u: GithubItemUpsert): boolean =>
      rules.some(
        (r) =>
          (r.kind === 'repo' && r.value === u.repo) ||
          (r.kind === 'author' && r.value.toLowerCase() === u.author.toLowerCase()) ||
          (r.kind === 'bots' && u.authorType === 'Bot') ||
          (r.kind === 'item' && r.value === u.id),
      );
    const res: UpsertGithubResult = { added: [], reopened: [], changed: [] };
    const at = now();
    const get = db.prepare('SELECT state, state_source, source_state, data FROM items WHERE id = ?');
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
         woke_at = @woke, snoozed_until = NULL WHERE id = @id`,
    );
    db.transaction(() => {
      for (const u of ups) {
        const isMine = mine.has(u.author.toLowerCase());
        const muted = muteHit(u);
        const data = JSON.stringify({
          number: u.number,
          draft: u.draft,
          association: u.association,
          authorType: u.authorType,
          comments: u.comments,
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
        const existing = get.get(u.id) as Row | undefined;
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
            feedId,
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
        const prevComments: number = parseData(existing.data).comments ?? 0;
        const wasOpen = existing.source_state === 'open';
        const state: CommentState = existing.state;
        if (isMine || muted) {
          if (u.sourceState !== 'open' && state === 'inbox' && existing.state_source !== 'user') {
            move.run({ id: u.id, state: 'resolved', at, reason: null, woke: null });
          }
          res.changed.push(u.id);
          continue;
        }
        if (u.sourceState !== 'open' && state === 'inbox' && existing.state_source !== 'user') {
          move.run({ id: u.id, state: 'resolved', at, reason: null, woke: null });
        } else if (u.sourceState === 'open' && state === 'resolved' && !wasOpen) {
          move.run({ id: u.id, state: 'inbox', at, reason: 'reopened', woke: at });
          res.reopened.push(u.id);
        } else if (
          u.sourceState === 'open' &&
          (state === 'done' || state === 'replied' || state === 'resolved') &&
          u.comments > prevComments &&
          u.lastCommenterIsMe !== true
        ) {
          move.run({ id: u.id, state: 'inbox', at, reason: 'new_activity', woke: at });
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
      db.prepare(
        `UPDATE items SET state = 'own', state_source = 'sync', state_changed_at = ?
         WHERE provider = 'github' AND is_own = 1 AND state != 'own' AND state_source != 'user'`,
      ).run(at);
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

export function parseData(s: unknown): Row {
  if (typeof s !== 'string' || !s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Row) : {};
  } catch {
    return {};
  }
}
