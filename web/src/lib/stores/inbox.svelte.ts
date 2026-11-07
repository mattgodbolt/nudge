import type { CommentState, Counts, InboxItem, InboxView, ServerEvent } from '../../../../shared/types';
import type { InboxPage } from '../../../../shared/api';
import { api } from '../api';
import { thread } from './thread.svelte';
import { toasts } from './toasts.svelte';

export interface InboxFilters {
  sourceId?: number;
  videoId?: string;
  q?: string;
}

export interface Change {
  item: InboxItem;
  from: CommentState;
  to: CommentState;
}

interface UndoEntry {
  changes: Change[];
  actionId: Promise<number>;
}

const PAGE = 100;

export function emptyCounts(): Counts {
  return { inbox: 0, done: 0, all: 0, bySource: {} };
}

export function viewIncludes(view: InboxView, state: CommentState): boolean {
  if (view === 'inbox') return state === 'inbox';
  if (view === 'done') return state === 'done' || state === 'replied' || state === 'auto_replied';
  return state !== 'own';
}

const isDone = (s: CommentState) => s === 'done' || s === 'replied' || s === 'auto_replied';

/** Mirrors the server sort: published_at DESC, id ASC. */
export function compareItems(a: InboxItem, b: InboxItem): number {
  if (a.comment.publishedAt !== b.comment.publishedAt) return a.comment.publishedAt < b.comment.publishedAt ? 1 : -1;
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

  /* ---------- triage ---------- */

  /** Triage `ids` (e.g. a row's own quick action), defaulting to the multi-selection or the cursor row. */
  triage(to: 'done' | 'replied' | 'inbox', only?: string[]): Promise<boolean> {
    const ids = only ?? (this.selectedIds.size > 0 ? [...this.selectedIds] : this.selectedId ? [this.selectedId] : []);
    const message = to === 'done' ? 'Marked done' : to === 'replied' ? 'Marked replied' : 'Moved back to inbox';
    return this.applyOptimistic(ids, to, () => api.triage(ids, to), {
      message: ids.length > 1 ? `${ids.length} items: ${message.toLowerCase()}` : message,
    });
  }

  /**
   * Apply a state change locally right away, then confirm with the server. `request` performs the call;
   * on failure everything is rolled back.
   */
  async applyOptimistic(
    ids: string[],
    to: CommentState,
    request: () => Promise<{ actionId: number; counts?: Counts }>,
    opts: { message?: string | null } = {},
  ): Promise<boolean> {
    const wanted = new Set(ids);
    const changes: Change[] = this.items
      .filter((i) => wanted.has(i.comment.id) && i.comment.state !== to)
      .map((item) => ({ item, from: item.comment.state, to }));
    if (changes.length === 0) return false;

    const prevCounts = $state.snapshot(this.counts) as Counts;
    const prevSelected = this.selectedId;
    const prevMulti = this.selectedIds;
    this.#setStates(changes, 'to');
    this.selectedIds = new Set();
    for (const c of changes) this.#inflight.add(c.item.comment.id);

    const promise = request();
    const entry: UndoEntry = { changes, actionId: promise.then((r) => r.actionId) };
    entry.actionId.catch(() => {});
    this.#undoStack.push(entry);
    this.undoDepth = this.#undoStack.length;
    try {
      const result = await promise;
      if (result.counts) this.counts = result.counts;
      if (opts.message !== null) {
        toasts.push({
          message: `${opts.message ?? 'Done'} · z to undo`,
          action: { label: 'Undo', run: () => void this.undo() },
        });
      }
      return true;
    } catch (e) {
      this.#undoStack = this.#undoStack.filter((x) => x !== entry);
      this.undoDepth = this.#undoStack.length;
      this.#setStates(changes, 'from');
      this.counts = prevCounts;
      if (prevSelected && this.items.some((i) => i.comment.id === prevSelected)) this.selectedId = prevSelected;
      this.selectedIds = prevMulti;
      toasts.error(`Could not update: ${e instanceof Error ? e.message : 'unknown error'}`);
      return false;
    } finally {
      for (const c of changes) this.#inflight.delete(c.item.comment.id);
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
    this.#setStates(entry.changes, 'from');
    const first = entry.changes.find((c) => viewIncludes(this.view, c.from));
    if (first) this.selectedId = first.item.comment.id;
    try {
      const actionId = await entry.actionId;
      const result = await api.undo(actionId);
      this.counts = result.counts;
      toasts.push({ message: 'Undone', timeoutMs: 2500 });
      return true;
    } catch (e) {
      this.#setStates(entry.changes, 'to');
      this.counts = prevCounts;
      toasts.error(`Could not undo: ${e instanceof Error ? e.message : 'unknown error'}`);
      return false;
    }
  }

  /** Apply `target` state of each change to the list and counts, moving the cursor sensibly when rows vanish. */
  #setStates(changes: Change[], target: 'to' | 'from') {
    const byId = new Map(changes.map((c) => [c.item.comment.id, c]));
    const counts: Counts = { ...this.counts, bySource: { ...this.counts.bySource } };
    for (const c of changes) {
      const [oldS, newS] = target === 'to' ? [c.from, c.to] : [c.to, c.from];
      counts.inbox += (newS === 'inbox' ? 1 : 0) - (oldS === 'inbox' ? 1 : 0);
      counts.done += (isDone(newS) ? 1 : 0) - (isDone(oldS) ? 1 : 0);
    }
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
      const state = target === 'to' ? c.to : c.from;
      if (viewIncludes(this.view, state)) next.push({ ...item, comment: { ...item.comment, state } });
    }
    for (const c of changes) {
      const state = target === 'to' ? c.to : c.from;
      if (!present.has(c.item.comment.id) && viewIncludes(this.view, state)) {
        next.push({ ...c.item, comment: { ...c.item.comment, state } });
      }
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
    const relevantAdds = this.view === 'done' ? [] : e.addedIds;
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
