import type { CommentState, Counts, InboxItem, InboxView, ServerEvent } from '../../../../shared/types';
import type { InboxPage } from '../../../../shared/api';
import { api } from '../api';
import { thread } from './thread.svelte';
import { toasts } from './toasts.svelte';

export interface InboxFilters {
  sourceId?: number;
  videoId?: string;
  labelId?: number;
  feedId?: number;
  kind?: 'pr' | 'issue';
  audience?: 'outside' | 'team' | 'contributors' | 'bots' | 'people';
  q?: string;
}

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

export function emptyCounts(): Counts {
  return { inbox: 0, done: 0, all: 0, snoozed: 0, bySource: {}, byLabel: {}, byFeed: {} };
}

const isDone = (s: CommentState) => s === 'done' || s === 'replied' || s === 'auto_replied' || s === 'resolved';

export function viewIncludes(view: InboxView, item: InboxItem, labelId?: number): boolean {
  if (labelId !== undefined && !item.labels.includes(labelId)) return false;
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
    labels: awake ? item.labels : [],
  };
}

/** Add `sign` * (tally(to) - tally(from)) to `counts`, returning a new object. */
function shiftCounts(counts: Counts, from: InboxItem, to: InboxItem, sign: 1 | -1 = 1): Counts {
  const a = tally(from);
  const b = tally(to);
  const byLabel = { ...counts.byLabel };
  for (const l of a.labels) byLabel[l] = Math.max(0, (byLabel[l] ?? 0) - sign);
  for (const l of b.labels) byLabel[l] = (byLabel[l] ?? 0) + sign;
  return {
    ...counts,
    inbox: counts.inbox + sign * (b.inbox - a.inbox),
    snoozed: counts.snoozed + sign * (b.snoozed - a.snoozed),
    done: counts.done + sign * (b.done - a.done),
    byLabel,
  };
}

/** Mirrors the server sort: COALESCE(woke_at, published_at) DESC, id ASC. */
function sortKey(i: InboxItem): string {
  return i.wokeAt ?? i.comment.publishedAt;
}
export function compareItems(a: InboxItem, b: InboxItem): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka !== kb) return ka < kb ? 1 : -1;
  return a.comment.id < b.comment.id ? -1 : a.comment.id > b.comment.id ? 1 : 0;
}

export class InboxStore {
  items = $state.raw<InboxItem[]>([]);
  view = $state<InboxView>('inbox');
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

  #generation = 0;
  #loadingMore = false;
  #undoStack: UndoEntry[] = [];
  /** Mirrors the undo stack length so the UI can enable/disable Undo. */
  undoDepth = $state(0);
  #inflight = new Set<string>();

  /* ---------- loading ---------- */

  #query(cursor?: string) {
    return { view: this.view, ...this.filters, cursor, limit: PAGE };
  }

  /** Switch view/filters; reloads only when something actually changed. */
  async configure(view: InboxView, filters: InboxFilters, selectId?: string | null): Promise<void> {
    const same =
      this.loaded &&
      view === this.view &&
      filters.sourceId === this.filters.sourceId &&
      filters.videoId === this.filters.videoId &&
      filters.labelId === this.filters.labelId &&
      filters.feedId === this.filters.feedId &&
      filters.kind === this.filters.kind &&
      filters.audience === this.filters.audience &&
      (filters.q ?? '') === (this.filters.q ?? '');
    if (same) {
      if (selectId && this.items.some((i) => i.comment.id === selectId)) this.selectedId = selectId;
      return;
    }
    const viewChanged = view !== this.view;
    this.view = view;
    this.filters = { ...filters };
    if (viewChanged) this.selectedIds = new Set();
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
    } catch (e) {
      if (gen !== this.#generation) return;
      this.error = e instanceof Error ? e.message : 'Could not load inbox';
      this.loaded = true;
    } finally {
      if (gen === this.#generation) this.loading = false;
    }
  }

  async loadMore(): Promise<void> {
    if (!this.nextCursor || this.#loadingMore || this.loading) return;
    this.#loadingMore = true;
    const gen = this.#generation;
    try {
      const page = await api.inbox(this.#query(this.nextCursor));
      if (gen !== this.#generation) return;
      const have = new Set(this.items.map((i) => i.comment.id));
      this.items = [
        ...this.items,
        ...page.items.filter((i) => !have.has(i.comment.id) && !this.#inflight.has(i.comment.id)),
      ];
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
    const fresh = page.items.filter((i) => !this.#inflight.has(i.comment.id));
    const freshIds = new Set(fresh.map((i) => i.comment.id));
    const last = page.nextCursor ? page.items[page.items.length - 1] : undefined;
    // Items beyond the fetched window are kept; everything inside it is replaced by the server's view.
    const tail = last ? this.items.filter((i) => !freshIds.has(i.comment.id) && compareItems(i, last) > 0) : [];
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

  selectAll() {
    if (this.items.length) this.selectedIds = new Set(this.items.map((i) => i.comment.id));
  }

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

  /* ---------- triage, snooze and labels ---------- */

  /** The ids an action applies to: explicit `only`, else the multi-selection, else the cursor row. */
  targetIds(only?: string[]): string[] {
    return only ?? (this.selectedIds.size > 0 ? [...this.selectedIds] : this.selectedId ? [this.selectedId] : []);
  }

  /** Triage `ids` (e.g. a row's own quick action), defaulting to the multi-selection or the cursor row. */
  triage(to: 'done' | 'replied' | 'inbox', only?: string[]): Promise<boolean> {
    const ids = this.targetIds(only);
    const message = to === 'done' ? 'Marked done' : to === 'replied' ? 'Marked replied' : 'Moved back to inbox';
    return this.applyOptimistic(ids, to, () => api.triage(ids, to), {
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
    opts: { message?: string | null; onError?: (e: unknown) => void } = {},
  ): Promise<boolean> {
    const wanted = new Set(ids);
    const changes: Change[] = this.items
      .filter((i) => wanted.has(i.comment.id) && i.comment.state !== to)
      .map((before) => ({ before, after: { ...before, comment: { ...before.comment, state: to } } }));
    return this.#commit(changes, 'triage', request, opts);
  }

  /**
   * Snooze (a Date) or unsnooze (null) `ids`. Only inbox-state comments can be snoozed, so other rows are
   * left alone. The row leaves the list like a triage would, and the action is undoable.
   */
  snooze(until: Date | null, only?: string[], label?: string): Promise<boolean> {
    const wanted = new Set(this.targetIds(only));
    const iso = until ? until.toISOString() : null;
    const changes: Change[] = this.items
      .filter((i) => wanted.has(i.comment.id) && (iso ? i.comment.state === 'inbox' : i.snoozedUntil !== null))
      .map((before) => ({ before, after: { ...before, snoozedUntil: iso } }));
    const ids = changes.map((c) => c.before.comment.id);
    const n = ids.length;
    const message = iso
      ? n > 1
        ? `${n} items snoozed until ${label ?? 'later'}`
        : `Snoozed until ${label ?? 'later'}`
      : n > 1
        ? `${n} items: unsnoozed`
        : 'Unsnoozed';
    return this.#commit(changes, 'snooze', () => api.snooze(ids, iso), { message });
  }

  unsnooze(only?: string[]): Promise<boolean> {
    return this.snooze(null, only);
  }

  async #commit(
    changes: Change[],
    kind: UndoEntry['kind'],
    request: () => Promise<CommitResult>,
    opts: { message?: string | null; onError?: (e: unknown) => void } = {},
  ): Promise<boolean> {
    if (changes.length === 0) return false;

    const prevCounts = $state.snapshot(this.counts) as Counts;
    const prevSelected = this.selectedId;
    const prevMulti = this.selectedIds;
    this.#setItems(changes, 'after');
    this.selectedIds = new Set();
    for (const c of changes) this.#inflight.add(c.before.comment.id);

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
      } else if (opts.message !== null) {
        toasts.push({
          message: `${opts.message ?? 'Done'} · z to undo`,
          action: { label: 'Undo', run: () => void this.undo() },
        });
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
      for (const c of changes) this.#inflight.delete(c.before.comment.id);
    }
  }

  async undo(): Promise<boolean> {
    const entry = this.#undoStack.pop();
    this.undoDepth = this.#undoStack.length;
    if (!entry) {
      toasts.push({ message: 'Nothing to undo', timeoutMs: 2000 });
      return false;
    }
    const prevCounts = $state.snapshot(this.counts) as Counts;
    this.#setItems(entry.changes, 'before');
    const first = entry.changes.find((c) => viewIncludes(this.view, c.before, this.filters.labelId));
    if (first) this.selectedId = first.before.comment.id;
    try {
      const actionId = await entry.actionId;
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

  /**
   * Add/remove labels on `ids` (default: selection or cursor row). Rows stay where they are (a label folder
   * does not drop a row you just un-labelled); counts follow. Rolled back with an error toast on failure.
   */
  async applyLabels(add: number[], remove: number[], only?: string[]): Promise<boolean> {
    const wanted = new Set(this.targetIds(only));
    const ids = this.items.filter((i) => wanted.has(i.comment.id)).map((i) => i.comment.id);
    if (ids.length === 0) return false;
    const change = (item: InboxItem): InboxItem => {
      const labels = [...item.labels.filter((l) => !remove.includes(l) || add.includes(l))];
      for (const l of add) if (!labels.includes(l)) labels.push(l);
      return labels.length === item.labels.length && labels.every((l, i) => l === item.labels[i])
        ? item
        : { ...item, labels };
    };
    const changed = this.items.map((i) => ({ before: i, after: wanted.has(i.comment.id) ? change(i) : i }));
    const moved = changed.filter((c) => c.before !== c.after);
    if (moved.length === 0) return true;

    const rollback = new Map(moved.map((c) => [c.before.comment.id, c.before.labels]));
    this.#replaceLabels(new Map(moved.map((c) => [c.before.comment.id, c.after.labels])));
    for (const c of moved) this.counts = shiftCounts(this.counts, c.before, c.after);
    for (const id of ids) this.#labelsPending.set(id, (this.#labelsPending.get(id) ?? 0) + 1);
    // Requests go out one at a time so the server applies them in the order the user made them, and a response only
    // overwrites a comment when no newer change to it is still outstanding (else a stale answer would undo a toggle).
    const run = this.#labelQueue.then(async () => {
      try {
        const result = await api.applyLabels(ids, add, remove);
        const settled = this.#settleLabels(ids);
        this.#replaceLabels(new Map(Object.entries(result.labels).filter(([id]) => settled.has(id))));
        if (this.#labelsPending.size === 0) this.counts = result.counts;
        return true;
      } catch (e) {
        const settled = this.#settleLabels(ids);
        this.#replaceLabels(new Map([...rollback].filter(([id]) => settled.has(id))));
        if (this.#labelsPending.size === 0) {
          for (const c of moved) this.counts = shiftCounts(this.counts, c.after, c.before);
        }
        toasts.error(`Could not update labels: ${e instanceof Error ? e.message : 'unknown error'}`);
        return false;
      }
    });
    this.#labelQueue = run.then(() => undefined);
    return run;
  }

  #labelQueue: Promise<void> = Promise.resolve();
  #labelsPending = new Map<string, number>();

  /** Mark one outstanding label request finished for these ids; returns those with nothing else outstanding. */
  #settleLabels(ids: string[]): Set<string> {
    const settled = new Set<string>();
    for (const id of ids) {
      const n = (this.#labelsPending.get(id) ?? 1) - 1;
      if (n <= 0) {
        this.#labelsPending.delete(id);
        settled.add(id);
      } else this.#labelsPending.set(id, n);
    }
    return settled;
  }

  /** Overwrite the label list of the given items in place. */
  #replaceLabels(byId: Map<string, number[]>) {
    if (byId.size === 0) return;
    this.items = this.items.map((i) => {
      const labels = byId.get(i.comment.id);
      return labels ? { ...i, labels } : i;
    });
  }

  /** Drop label ids that no longer exist (a label was deleted). */
  pruneLabels(valid: ReadonlySet<number>) {
    if (this.items.some((i) => i.labels.some((l) => !valid.has(l)))) {
      this.items = this.items.map((i) =>
        i.labels.every((l) => valid.has(l)) ? i : { ...i, labels: i.labels.filter((l) => valid.has(l)) },
      );
    }
    const byLabel = Object.fromEntries(Object.entries(this.counts.byLabel).filter(([k]) => valid.has(Number(k))));
    if (Object.keys(byLabel).length !== Object.keys(this.counts.byLabel).length) {
      this.counts = { ...this.counts, byLabel };
    }
  }

  /** Move every change to its `target` side, keeping the list sorted, counts in step and the cursor sensible. */
  #setItems(changes: Change[], target: 'before' | 'after') {
    const other = target === 'after' ? 'before' : 'after';
    const byId = new Map(changes.map((c) => [c.before.comment.id, c]));
    let counts = this.counts;
    for (const c of changes) counts = shiftCounts(counts, c[other], c[target]);
    this.counts = counts;

    const labelId = this.filters.labelId;
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
      // Keep the freshest label list: it may have changed since the change was recorded.
      const updated = { ...c[target], labels: item.labels };
      if (viewIncludes(this.view, updated, labelId)) next.push(updated);
    }
    for (const c of changes) {
      if (!present.has(c.before.comment.id) && viewIncludes(this.view, c[target], labelId)) next.push(c[target]);
    }
    next.sort(compareItems);
    this.items = next;
    this.total = Math.max(0, this.total + (next.length - oldItems.length));

    if (this.selectedId && !next.some((i) => i.comment.id === this.selectedId)) {
      // Prefer the row that slid into the vacated slot, else the one above.
      let pick: InboxItem | undefined;
      for (let i = selIdx + 1; i < oldItems.length && !pick; i++) {
        pick = next.find((n) => n.comment.id === oldItems[i]!.comment.id);
      }
      for (let i = selIdx - 1; i >= 0 && !pick; i--) {
        pick = next.find((n) => n.comment.id === oldItems[i]!.comment.id);
      }
      this.selectedId = pick?.comment.id ?? null;
    }
    if (this.selectedId === null && next.length) this.selectedId = next[0]!.comment.id;
  }

  /* ---------- server events ---------- */

  applyServerEvent(e: ServerEvent) {
    if (e.type !== 'inbox.changed') return;
    this.counts = e.counts;
    thread.invalidate();
    const touched = e.changedIds.some((id) => this.items.some((i) => i.comment.id === id));
    const relevantAdds = this.view === 'done' || this.view === 'snoozed' ? [] : e.addedIds;
    if (relevantAdds.length === 0 && !touched) return;
    const atTop = this.selectedIndex <= 0;
    if (atTop && !this.composing) {
      void this.refreshTop();
    } else if (relevantAdds.length) {
      const next = new Set(this.pending);
      for (const id of relevantAdds) if (!this.items.some((i) => i.comment.id === id)) next.add(id);
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
