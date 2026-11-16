import type {
  CommentState,
  DoneReason,
  Counts,
  InboxItem,
  InboxOrder,
  InboxView,
  ServerEvent,
  SnoozeBucket,
  SuggestionDTO,
  TriageTarget,
} from '../../../../shared/types';
import type { InboxPage } from '../../../../shared/api';
import { DEFAULT_SNOOZE_DAYS, SNOOZE_BUCKETS, fallbackDate } from '../../../../shared/snooze';
import { api } from '../api';
import { settings } from './settings.svelte';
import { thread } from './thread.svelte';
import { toasts } from './toasts.svelte';
import { usage } from '../usage';
import { decisions } from '../decisions';
import { formatSnoozeTime } from '../snooze';
import { FILTER_KEYS, sameFilters, type InboxFilters } from '../filters';

export type { InboxFilters };

/** One item's optimistic transition. The same shape serves triage, snooze and their undo. */
export interface Change {
  before: InboxItem;
  after: InboxItem;
}

interface UndoEntry {
  changes: Change[];
  /** Null when the server reported that nothing changed. */
  actionId: Promise<number | null>;
  kind: 'triage' | 'snooze';
}

interface CommitResult {
  actionId: number | null;
  counts?: Counts;
}

const PAGE = 100;
/** Ids per request when re-reading changed rows (the server takes up to 500; this keeps the URL short). */
const PATCH_CHUNK = 100;
/** How far a deep link may page in to reach its item. */
const REVEAL_MAX = 5000;

export function emptyCounts(): Counts {
  return { inbox: 0, done: 0, all: 0, snoozed: 0, bySource: {}, byFeed: {}, byRepo: {}, todos: 0 };
}

const isDone = (s: CommentState) => s === 'done' || s === 'replied' || s === 'auto_replied' || s === 'resolved';

export function viewIncludes(view: InboxView, item: InboxItem): boolean {
  const { state } = item.comment;
  if (view === 'inbox') return state === 'inbox' && !item.snoozedUntil;
  if (view === 'snoozed') return state === 'inbox' && !!item.snoozedUntil;
  if (view === 'done') return isDone(state);
  return state !== 'own';
}

/** The sidebar-count buckets an item contributes to (mirrors the server's Counts). */
function tally(item: InboxItem) {
  const { state } = item.comment;
  const awake = state === 'inbox' && !item.snoozedUntil;
  return {
    inbox: awake ? 1 : 0,
    snoozed: state === 'inbox' && item.snoozedUntil ? 1 : 0,
    done: isDone(state) ? 1 : 0,
  };
}

/** Add `sign` * (tally(to) - tally(from)) to `counts`, returning a new object. */
function shiftCounts(counts: Counts, from: InboxItem, to: InboxItem, sign: 1 | -1 = 1): Counts {
  const a = tally(from);
  const b = tally(to);
  return {
    ...counts,
    inbox: counts.inbox + sign * (b.inbox - a.inbox),
    snoozed: counts.snoozed + sign * (b.snoozed - a.snoozed),
    done: counts.done + sign * (b.done - a.done),
  };
}

/** Mirrors the server sorts (see listInbox): a key, optionally preceded by a source rank, then id ascending. */
const sortKey = (i: InboxItem, order: InboxOrder): string =>
  order === 'arrived' ? (i.wokeAt ?? i.arrivedAt) : (i.wokeAt ?? i.comment.publishedAt);
const rank = (i: InboxItem): number => (i.item.provider === 'todo' ? 0 : i.item.provider === 'github' ? 1 : 2);
/** In the Snoozed view the rank is the reason bucket (see listInbox): sections, with no bucket last. */
const bucketRank = (i: InboxItem): number =>
  i.snoozeBucket ? SNOOZE_BUCKETS.indexOf(i.snoozeBucket) : SNOOZE_BUCKETS.length;
export function compareItems(
  a: InboxItem,
  b: InboxItem,
  order: InboxOrder = 'newest',
  view: InboxView = 'inbox',
): number {
  if (view === 'snoozed') {
    if (bucketRank(a) !== bucketRank(b)) return bucketRank(a) - bucketRank(b);
  } else if (order === 'source' && rank(a) !== rank(b)) return rank(a) - rank(b);
  const ka = sortKey(a, order);
  const kb = sortKey(b, order);
  if (ka !== kb) return (ka < kb ? 1 : -1) * (order === 'oldest' ? -1 : 1);
  return a.comment.id < b.comment.id ? -1 : a.comment.id > b.comment.id ? 1 : 0;
}

const ORDER_KEY = 'nudge-inbox-order';
const ORDERS: readonly InboxOrder[] = ['newest', 'oldest', 'arrived', 'source'];
function savedOrder(): InboxOrder {
  try {
    const v = localStorage.getItem(ORDER_KEY);
    return ORDERS.find((o) => o === v) ?? 'newest';
  } catch {
    return 'newest';
  }
}

export class InboxStore {
  items = $state.raw<InboxItem[]>([]);
  view = $state<InboxView>('inbox');
  /** How the list is sorted; remembered in this browser. */
  order = $state<InboxOrder>(savedOrder());
  filters = $state<InboxFilters>({});
  selectedId = $state<string | null>(null);
  selectedIds = $state.raw<ReadonlySet<string>>(new Set());
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);
  nextCursor = $state<string | null>(null);
  total = $state(0);
  counts = $state<Counts>(emptyCounts());
  /** Ids of new items that arrived while the user was busy ("N new" pill). */
  pending = $state.raw<ReadonlySet<string>>(new Set());
  /** True while the composer has focus, to avoid moving the list underneath. */
  composing = false;

  selectedIndex = $derived(
    this.selectedId === null ? -1 : this.items.findIndex((i) => i.comment.id === this.selectedId),
  );
  selected = $derived<InboxItem | null>(this.items[this.selectedIndex] ?? null);
  pendingCount = $derived(this.pending.size);

  /** What the list on screen is, for habit context: search, a source, else the inbox/done/... view. */
  get viewName(): string {
    const f = this.filters;
    if (f.q) return 'search';
    if (f.sourceId !== undefined || f.feedId !== undefined || f.videoId !== undefined || f.repo !== undefined)
      return 'source';
    return this.view;
  }

  /** Habit context for an action on `ids`; call before the list mutates so rank and `above` are what was seen. */
  #decide(action: string, ids: string[]) {
    // In 'all' the list still holds finished items, which were not "passed over" by acting on something below them.
    const all = this.view === 'all';
    decisions.decide({
      action,
      view: this.viewName,
      list: this.items.map((i) => ({
        id: i.comment.id,
        passable: !all || (i.comment.state === 'inbox' && !i.snoozedUntil),
      })),
      targets: ids,
    });
  }

  #generation = 0;
  #loadingMore = false;
  #undoStack: UndoEntry[] = [];
  /** Mirrors the undo stack length so the UI can enable/disable Undo. */
  undoDepth = $state(0);
  /**
   * Ids with an action of ours (triage, snooze or undo) on its way to the server, counted since an undo can overlap
   * the request it undoes. Until it lands, what the server says about them is out of date, so refreshes keep ours.
   */
  #inflight = new Map<string, number>();
  #busy(id: string): boolean {
    return (this.#inflight.get(id) ?? 0) > 0;
  }
  #hold(changes: Change[]) {
    for (const c of changes)
      this.#inflight.set(c.before.comment.id, (this.#inflight.get(c.before.comment.id) ?? 0) + 1);
  }
  #release(changes: Change[]) {
    for (const c of changes) {
      const id = c.before.comment.id;
      const n = (this.#inflight.get(id) ?? 0) - 1;
      if (n > 0) this.#inflight.set(id, n);
      else this.#inflight.delete(id);
    }
  }

  /* ---------- loading ---------- */

  #query(cursor?: string) {
    return { view: this.view, ...this.filters, order: this.order, cursor, limit: PAGE };
  }

  /** Change the sort order and reload from the top. */
  async setOrder(order: InboxOrder): Promise<void> {
    if (order === this.order) return;
    this.order = order;
    try {
      localStorage.setItem(ORDER_KEY, order);
    } catch {
      /* storage unavailable */
    }
    this.nextCursor = null;
    await this.load();
  }
  cycleOrder(): Promise<void> {
    return this.setOrder(ORDERS[(ORDERS.indexOf(this.order) + 1) % ORDERS.length]!);
  }

  /** Switch view/filters; reloads only when something actually changed. */
  async configure(view: InboxView, filters: InboxFilters, selectId?: string | null): Promise<void> {
    const same = this.loaded && view === this.view && sameFilters(filters, this.filters);
    if (same) {
      if (selectId && this.items.some((i) => i.comment.id === selectId)) this.selectedId = selectId;
      else if (selectId) void this.#reveal(selectId);
      return;
    }
    const viewChanged = view !== this.view;
    // Counts only: that a search ran or a filter was applied, never what it was.
    if (filters.q && filters.q !== this.filters.q) usage.count('search.run');
    if (FILTER_KEYS.some((k) => filters[k] !== undefined && filters[k] !== this.filters[k])) {
      usage.count('filter.applied');
    }
    this.view = view;
    this.filters = { ...filters };
    // A selection made under another filter would otherwise still be acted on by Done/Snooze, unseen.
    this.selectedIds = new Set();
    await this.load(selectId);
  }

  async load(selectId?: string | null): Promise<void> {
    const gen = ++this.#generation;
    this.loading = true;
    this.error = null;
    try {
      const page = await api.inbox(this.#query());
      if (gen !== this.#generation) return;
      this.items = page.items;
      this.nextCursor = page.nextCursor;
      this.total = page.total;
      this.pending = new Set();
      this.loaded = true;
      const keep = selectId ?? this.selectedId;
      this.selectedId = page.items.find((i) => i.comment.id === keep)?.comment.id ?? page.items[0]?.comment.id ?? null;
      if (selectId && this.selectedId !== selectId) void this.#reveal(selectId);
    } catch (e) {
      if (gen !== this.#generation) return;
      this.error = e instanceof Error ? e.message : 'Could not load inbox';
      this.loaded = true;
    } finally {
      if (gen === this.#generation) this.loading = false;
    }
  }

  /**
   * A link to an item that is not on the loaded pages (an Insights link, a notification tap, the list sorted oldest
   * first): if it belongs in this list at all, load pages until it is reached, then select it.
   */
  async #reveal(id: string): Promise<void> {
    const gen = this.#generation;
    try {
      const found = await api.inbox({ ...this.#query(), ids: [id], limit: 1 });
      if (gen !== this.#generation || found.items.length === 0) return;
    } catch {
      return;
    }
    const has = () => this.items.some((i) => i.comment.id === id);
    let stalls = 0;
    while (!has() && this.nextCursor && this.items.length < REVEAL_MAX && stalls < 50 && gen === this.#generation) {
      const before = this.items.length;
      await this.loadMore();
      if (this.items.length === before) {
        stalls++;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (gen === this.#generation && has()) this.selectedId = id;
  }

  async loadMore(): Promise<void> {
    if (!this.nextCursor || this.#loadingMore || this.loading) return;
    this.#loadingMore = true;
    const gen = this.#generation;
    try {
      const page = await api.inbox(this.#query(this.nextCursor));
      if (gen !== this.#generation) return;
      const have = new Set(this.items.map((i) => i.comment.id));
      this.items = [...this.items, ...page.items.filter((i) => !have.has(i.comment.id) && !this.#busy(i.comment.id))];
      this.nextCursor = page.nextCursor;
      this.total = page.total;
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not load more');
    } finally {
      this.#loadingMore = false;
    }
  }

  /** Merge a freshly fetched first page into the loaded list without disturbing selection. */
  #mergeFirstPage(page: InboxPage) {
    // A repeated id would give VirtualList two rows with one key, and two slots drawn on top of each other.
    const seen = new Set<string>();
    const local = new Map(this.items.map((i) => [i.comment.id, i]));
    const fresh: InboxItem[] = [];
    for (const i of page.items) {
      const id = i.comment.id;
      if (seen.has(id)) continue;
      seen.add(id);
      // A row with an action of ours in flight keeps our copy (or stays out, if ours removed it).
      const mine = this.#busy(id) ? local.get(id) : i;
      if (mine) fresh.push(mine);
    }
    // And a row ours brought back (an undo) that the server, not yet told, left out of its page.
    const extra = [...local].filter(([id]) => this.#busy(id) && !seen.has(id)).map(([, i]) => i);
    if (extra.length) {
      fresh.push(...extra);
      fresh.sort((x, y) => compareItems(x, y, this.order, this.view));
    }
    const freshIds = new Set(fresh.map((i) => i.comment.id));
    const last = page.nextCursor ? page.items[page.items.length - 1] : undefined;
    // Items beyond the fetched window are kept; everything inside it is replaced by the server's view.
    const tail = last
      ? this.items.filter((i) => !freshIds.has(i.comment.id) && compareItems(i, last, this.order, this.view) > 0)
      : [];
    const prevIndex = this.selectedIndex;
    this.items = [...fresh, ...tail];
    if (!this.items.some((i) => i.comment.id === this.selectedId)) {
      this.selectedId = this.items[Math.min(Math.max(prevIndex, 0), this.items.length - 1)]?.comment.id ?? null;
    }
    this.total = page.total;
    if (tail.length === 0) this.nextCursor = page.nextCursor;
    this.pending = new Set();
  }

  async refreshTop(): Promise<void> {
    const gen = this.#generation;
    try {
      const page = await api.inbox(this.#query());
      if (gen === this.#generation) this.#mergeFirstPage(page);
    } catch {
      /* the next event retries */
    }
  }

  /** The "N new · press ." action. */
  async showPending(): Promise<void> {
    await this.refreshTop();
    if (this.items.length > 0) this.selectedId = this.items[0]!.comment.id;
  }

  /* ---------- selection ---------- */

  select(id: string) {
    this.selectedId = id;
  }

  move(delta: number) {
    if (this.items.length === 0) return;
    const idx = Math.min(Math.max((this.selectedIndex < 0 ? 0 : this.selectedIndex) + delta, 0), this.items.length - 1);
    this.selectedId = this.items[idx]!.comment.id;
  }

  toggleSelect(id = this.selectedId) {
    if (!id) return;
    const next = new Set(this.selectedIds);
    if (!next.delete(id)) next.add(id);
    this.selectedIds = next;
  }

  extendSelection(delta: number) {
    if (!this.selectedId) return;
    const next = new Set(this.selectedIds);
    next.add(this.selectedId);
    const before = this.selectedIndex;
    this.move(delta);
    if (this.selectedIndex !== before && this.selectedId) next.add(this.selectedId);
    this.selectedIds = next;
  }

  /** Select every item of the list on screen (that is, only what the current view, filter and search show). */
  selectAll() {
    if (this.items.length) this.selectedIds = new Set(this.items.map((i) => i.comment.id));
  }

  /**
   * Every item the list matches, not just the pages loaded so far: loads the rest (up to `max`) and selects all of
   * it. The selection is always of rows on screen, so acting on it is acting on what the filter shows.
   */
  async selectAllMatching(max = 5000): Promise<void> {
    let stalls = 0;
    while (this.nextCursor && this.items.length < max && stalls < 50) {
      const before = this.items.length;
      await this.loadMore();
      if (this.items.length === before) {
        stalls++;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    this.selectAll();
  }

  /** Selected items that are in the list on screen: what a bulk action would really touch. */
  selectedCount = $derived.by(() => {
    if (this.selectedIds.size === 0) return 0;
    let n = 0;
    for (const i of this.items) if (this.selectedIds.has(i.comment.id)) n++;
    return n;
  });

  clearSelection() {
    if (this.selectedIds.size) this.selectedIds = new Set();
  }

  setHasDraft(id: string, hasDraft: boolean) {
    const idx = this.items.findIndex((i) => i.comment.id === id);
    const item = this.items[idx];
    if (!item || item.hasDraft === hasDraft) return;
    const items = this.items.slice();
    items[idx] = { ...item, hasDraft };
    this.items = items;
  }

  /* ---------- triage and snooze ---------- */

  /** The ids an action applies to: explicit `only`, else the multi-selection, else the cursor row. */
  targetIds(only?: string[]): string[] {
    if (only) return only;
    if (this.selectedIds.size > 0) {
      // Only rows still on screen: an id left over from another filter or a finished item must not be acted on unseen.
      const shown = this.items.filter((i) => this.selectedIds.has(i.comment.id)).map((i) => i.comment.id);
      if (shown.length > 0) return shown;
    }
    return this.selectedId ? [this.selectedId] : [];
  }

  /** Triage `ids` (e.g. a row's own quick action), defaulting to the multi-selection or the cursor row. */
  triage(to: TriageTarget, only?: string[]): Promise<boolean> {
    const ids = this.targetIds(only);
    const message =
      to === 'done'
        ? 'Marked done'
        : to === 'dismissed'
          ? 'Marked no action needed'
          : to === 'replied'
            ? 'Marked replied'
            : 'Moved back to inbox';
    // A dismissal is a done item with a reason, everywhere but the wire's `to`.
    const state: CommentState = to === 'dismissed' ? 'done' : to;
    return this.applyOptimistic(ids, state, () => api.triage(ids, to), {
      reason: to === 'dismissed' ? 'no_action' : null,
      decision: to,
      message: ids.length > 1 ? `${ids.length} items: ${message.toLowerCase()}` : message,
    });
  }

  /**
   * Apply a state change locally right away, then confirm with the server. `request` performs the call;
   * on failure everything is rolled back.
   */
  applyOptimistic(
    ids: string[],
    to: CommentState,
    request: () => Promise<{ actionId: number; counts?: Counts }>,
    opts: {
      message?: string | null;
      onError?: (e: unknown) => void;
      /** Why it is done ('no_action' = dismissed); only meaningful when `to` is 'done'. */
      reason?: DoneReason | null;
      /** What to record as the decision when it differs from the state ('dismissed'). */
      decision?: string;
      /** Called once the server confirms, with an undo for exactly this action (for a caller's own toast). */
      onUndoable?: (undo: () => Promise<boolean>) => void;
    } = {},
  ): Promise<boolean> {
    const wanted = new Set(ids);
    const reason = to === 'done' ? (opts.reason ?? null) : null;
    const changes: Change[] = this.items
      .filter(
        (i) =>
          wanted.has(i.comment.id) &&
          (i.comment.state !== to || (to === 'done' && (i.comment.doneReason ?? null) !== reason)),
      )
      .map((before) => {
        const { doneReason: _old, ...rest } = before.comment;
        return {
          before,
          after: { ...before, comment: { ...rest, state: to, ...(reason ? { doneReason: reason } : {}) } },
        };
      });
    this.#decide(
      opts.decision ?? to,
      changes.map((c) => c.before.comment.id),
    );
    return this.#commit(changes, 'triage', request, opts);
  }

  /**
   * Snooze (a Date) or unsnooze (null) `ids`. Only inbox-state comments can be snoozed, so other rows are
   * left alone. The row leaves the list like a triage would, and the action is undoable.
   */
  snooze(
    until: Date | null,
    only?: string[],
    label?: string,
    why?: string,
    opts: { bucket?: SnoozeBucket | null; untilActivity?: boolean } = {},
  ): Promise<boolean> {
    const wanted = new Set(this.targetIds(only));
    const iso = until ? until.toISOString() : null;
    const changes: Change[] = this.items
      .filter((i) => wanted.has(i.comment.id) && (iso ? i.comment.state === 'inbox' : i.snoozedUntil !== null))
      .map((before) => ({
        before,
        after: {
          ...before,
          snoozedUntil: iso,
          snoozeUntilActivity: !!iso && opts.untilActivity === true,
          ...(iso
            ? {
                snoozeWhy: why?.trim() || null,
                snoozeBucket: opts.bucket ?? null,
                snoozedAt: new Date().toISOString(),
                wakeCause: null,
                snoozeNag: null,
              }
            : {}),
        },
      }));
    const ids = changes.map((c) => c.before.comment.id);
    this.#decide(iso ? 'snooze' : 'unsnooze', ids);
    const n = ids.length;
    const message = iso
      ? n > 1
        ? `${n} items snoozed until ${label ?? 'later'}`
        : `Snoozed until ${label ?? 'later'}`
      : n > 1
        ? `${n} items: unsnoozed`
        : 'Unsnoozed';
    return this.#commit(changes, 'snooze', () => api.snooze(ids, iso, why?.trim() || undefined, opts), { message });
  }

  unsnooze(only?: string[]): Promise<boolean> {
    return this.snooze(null, only);
  }

  /**
   * "Still waiting": snooze the items that came back with no activity once more, until activity again, keeping each
   * one's reason bucket and words. Items of different buckets get their own bucket's follow-up (one request per bucket).
   */
  async snoozeAgain(only?: string[]): Promise<boolean> {
    const wanted = new Set(this.targetIds(only));
    const nagging = this.items.filter((i) => wanted.has(i.comment.id) && i.snoozeNag);
    const groups = new Map<string, InboxItem[]>();
    for (const i of nagging) {
      const k = `${i.snoozeNag!.bucket ?? ''}\n${i.snoozeWhy ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    let any = false;
    for (const group of groups.values()) {
      const first = group[0]!;
      const bucket = first.snoozeNag!.bucket;
      const at = fallbackDate(new Date(), bucket, settings.value?.snoozeDays ?? DEFAULT_SNOOZE_DAYS);
      const when = formatSnoozeTime(at, new Date());
      const ok = await this.snooze(
        at,
        group.map((i) => i.comment.id),
        `activity (or ${when})`,
        first.snoozeWhy ?? undefined,
        { bucket, untilActivity: true },
      );
      any = any || ok;
    }
    return any;
  }

  async #commit(
    changes: Change[],
    kind: UndoEntry['kind'],
    request: () => Promise<CommitResult>,
    opts: {
      message?: string | null;
      onError?: (e: unknown) => void;
      onUndoable?: (undo: () => Promise<boolean>) => void;
    } = {},
  ): Promise<boolean> {
    if (changes.length === 0) return false;
    if (changes.length > 1) usage.count('bulk.apply');

    const prevCounts = $state.snapshot(this.counts) as Counts;
    const prevSelected = this.selectedId;
    const prevMulti = this.selectedIds;
    this.#setItems(changes, 'after');
    this.selectedIds = new Set();
    this.#hold(changes);

    const promise = request();
    const entry: UndoEntry = { changes, kind, actionId: promise.then((r) => r.actionId) };
    entry.actionId.catch(() => {});
    this.#undoStack.push(entry);
    this.undoDepth = this.#undoStack.length;
    try {
      const result = await promise;
      if (result.counts) this.counts = result.counts;
      if (result.actionId === null) {
        // Nothing changed server-side: there is nothing to undo.
        this.#undoStack = this.#undoStack.filter((x) => x !== entry);
        this.undoDepth = this.#undoStack.length;
      } else if (this.#undoStack.includes(entry)) {
        // (Not when z already undid it while the request was in flight.) A toast's Undo is for its own action: with
        // several toasts on screen, the newest action is not necessarily the one being clicked.
        const undo = () => this.undo(entry);
        opts.onUndoable?.(undo);
        if (opts.message !== null) {
          toasts.push({
            message: `${opts.message ?? 'Done'} · z to undo`,
            action: { label: 'Undo', run: () => void undo() },
          });
        }
      }
      return true;
    } catch (e) {
      this.#undoStack = this.#undoStack.filter((x) => x !== entry);
      this.undoDepth = this.#undoStack.length;
      this.#setItems(changes, 'before');
      this.counts = prevCounts;
      if (prevSelected && this.items.some((i) => i.comment.id === prevSelected)) this.selectedId = prevSelected;
      this.selectedIds = prevMulti;
      if (opts.onError) opts.onError(e);
      else toasts.error(`Could not update: ${e instanceof Error ? e.message : 'unknown error'}`);
      return false;
    } finally {
      this.#release(changes);
    }
  }

  /** Undo `target` (a toast's own action), or else the newest action. */
  async undo(target?: UndoEntry): Promise<boolean> {
    const entry = target ? this.#undoStack.find((x) => x === target) : this.#undoStack.at(-1);
    this.#undoStack = this.#undoStack.filter((x) => x !== entry);
    this.undoDepth = this.#undoStack.length;
    if (!entry) {
      toasts.push({ message: target ? 'Already undone' : 'Nothing to undo', timeoutMs: 2000 });
      return false;
    }
    const prevCounts = $state.snapshot(this.counts) as Counts;
    this.#setItems(entry.changes, 'before');
    const first = entry.changes.find((c) => viewIncludes(this.view, c.before));
    if (first) this.selectedId = first.before.comment.id;
    this.#hold(entry.changes);
    try {
      return await this.#undoOnServer(entry, prevCounts);
    } finally {
      this.#release(entry.changes);
    }
  }

  async #undoOnServer(entry: UndoEntry, prevCounts: Counts): Promise<boolean> {
    let actionId: number | null;
    try {
      actionId = await entry.actionId;
    } catch {
      // The original request failed: #commit has already rolled back and said so, so there is nothing left to undo.
      return false;
    }
    try {
      if (actionId === null) throw new Error('nothing to undo');
      const result = entry.kind === 'snooze' ? await api.undoSnooze(actionId) : await api.undo(actionId);
      this.counts = result.counts;
      toasts.push({ message: 'Undone', timeoutMs: 2500 });
      return true;
    } catch (e) {
      this.#setItems(entry.changes, 'after');
      this.counts = prevCounts;
      toasts.error(`Could not undo: ${e instanceof Error ? e.message : 'unknown error'}`);
      return false;
    }
  }

  /** Attach arrived suggestions in place: no reordering, no refetch, so the cursor and scroll position stay put. */
  applySuggestions(next: Record<string, SuggestionDTO | null>) {
    if (!this.items.some((i) => i.comment.id in next)) return;
    this.items = this.items.map((i) => (i.comment.id in next ? { ...i, suggestion: next[i.comment.id] ?? null } : i));
  }

  /** Move every change to its `target` side, keeping the list sorted, counts in step and the cursor sensible. */
  #setItems(changes: Change[], target: 'before' | 'after') {
    const other = target === 'after' ? 'before' : 'after';
    const byId = new Map(changes.map((c) => [c.before.comment.id, c]));
    let counts = this.counts;
    for (const c of changes) counts = shiftCounts(counts, c[other], c[target]);
    this.counts = counts;

    const oldItems = this.items;
    const selIdx = this.selectedIndex;
    const next: InboxItem[] = [];
    const present = new Set<string>();
    for (const item of oldItems) {
      const c = byId.get(item.comment.id);
      if (!c) {
        next.push(item);
        continue;
      }
      present.add(item.comment.id);
      if (viewIncludes(this.view, c[target])) next.push(c[target]);
    }
    for (const c of changes) {
      if (!present.has(c.before.comment.id) && viewIncludes(this.view, c[target])) next.push(c[target]);
    }
    next.sort((x, y) => compareItems(x, y, this.order, this.view));
    this.items = next;
    this.total = Math.max(0, this.total + (next.length - oldItems.length));

    this.#keepCursor(oldItems, selIdx);
  }

  /** After rows left the list: if the cursor's row went, take the row that slid into its slot, else the one above. */
  #keepCursor(oldItems: InboxItem[], selIdx: number) {
    const next = this.items;
    const shown = new Set(next.map((i) => i.comment.id));
    if (this.selectedId && !shown.has(this.selectedId)) {
      let pick: string | undefined;
      for (let i = selIdx + 1; i < oldItems.length && !pick; i++) {
        if (shown.has(oldItems[i]!.comment.id)) pick = oldItems[i]!.comment.id;
      }
      for (let i = selIdx - 1; i >= 0 && !pick; i--) {
        if (shown.has(oldItems[i]!.comment.id)) pick = oldItems[i]!.comment.id;
      }
      this.selectedId = pick ?? null;
    }
    if (this.selectedId === null && next.length) this.selectedId = next[0]!.comment.id;
  }

  /**
   * Re-read loaded rows the server says changed, keeping the list where it is: a row that still belongs is replaced
   * in its slot, one that no longer does (finished on the phone, closed upstream) leaves. Rows with an action of ours
   * in flight are left to it, and so is the row being replied to.
   */
  async #patchRows(ids: string[]) {
    const gen = this.#generation;
    const busyAtStart = new Set(ids.filter((id) => this.#busy(id)));
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += PATCH_CHUNK) chunks.push(ids.slice(i, i + PATCH_CHUNK));
    let fresh: Map<string, InboxItem>;
    try {
      const pages = await Promise.all(
        chunks.map((chunk) => api.inbox({ ...this.#query(), ids: chunk, limit: chunk.length })),
      );
      fresh = new Map(pages.flatMap((p) => p.items).map((i) => [i.comment.id, i]));
    } catch {
      return; // the next event, or a refresh, tries again
    }
    if (gen !== this.#generation) return;
    const asked = new Set(ids);
    // Busy when asked or now: the server's answer may predate our action landing.
    const keep = (id: string) =>
      !asked.has(id) || busyAtStart.has(id) || this.#busy(id) || (this.composing && id === this.selectedId);
    const oldItems = this.items;
    const selIdx = this.selectedIndex;
    const next: InboxItem[] = [];
    for (const i of oldItems) {
      const id = i.comment.id;
      if (keep(id)) next.push(i);
      else {
        const f = fresh.get(id);
        if (f) next.push(f);
      }
    }
    if (next.length === oldItems.length && next.every((i, k) => i === oldItems[k])) return;
    this.items = next;
    this.total = Math.max(0, this.total - (oldItems.length - next.length));
    this.#keepCursor(oldItems, selIdx);
  }

  /* ---------- server events ---------- */

  applyServerEvent(e: ServerEvent) {
    if (e.type !== 'inbox.changed') return;
    this.counts = e.counts;
    thread.invalidate();
    const loaded = new Set(this.items.map((i) => i.comment.id));
    // Rows on screen are updated where they are, wherever the cursor is.
    const touched = e.changedIds.filter((id) => loaded.has(id));
    if (touched.length) void this.#patchRows(touched);
    // New arrivals only ever land in the inbox (and All). In Done and Snoozed an item arrives by changing state
    // elsewhere, and which changed ids now belong is only known by asking, so there the top is refreshed when it is
    // safe to and otherwise left for the next look.
    const settled = this.view === 'done' || this.view === 'snoozed';
    const incoming = (settled ? e.changedIds : e.addedIds).filter((id) => !loaded.has(id));
    if (incoming.length === 0) return;
    if (this.selectedIndex <= 0 && !this.composing) {
      void this.refreshTop();
    } else if (!settled) {
      const next = new Set(this.pending);
      for (const id of incoming) next.add(id);
      this.pending = next;
    }
  }

  /** Test helper. */
  reset() {
    this.items = [];
    this.view = 'inbox';
    this.filters = {};
    this.selectedId = null;
    this.selectedIds = new Set();
    this.loaded = false;
    this.nextCursor = null;
    this.total = 0;
    this.counts = emptyCounts();
    this.pending = new Set();
    this.#undoStack = [];
    this.undoDepth = 0;
    this.#inflight.clear();
    this.#generation++;
  }
}

export const inbox = new InboxStore();
