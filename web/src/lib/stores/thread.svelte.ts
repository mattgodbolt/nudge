import type { ThreadDetail } from '../../../../shared/types';
import { api } from '../api';

const CAPACITY = 50;

export class ThreadStore {
  current = $state.raw<ThreadDetail | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  #cache = new Map<string, ThreadDetail>();
  /** Cached threads the server has since said may have changed: still shown, but fetched again. */
  #stale = new Set<string>();
  /** Bumped by invalidate(), so an answer to a request made before it is not taken as fresh. */
  #epoch = 0;
  #inflight = new Map<string, { epoch: number; p: Promise<ThreadDetail | null> }>();
  #wanted: string | null = null;

  get(id: string): ThreadDetail | undefined {
    return this.#cache.get(id);
  }

  #put(d: ThreadDetail) {
    this.#cache.delete(d.threadId);
    this.#cache.set(d.threadId, d);
    while (this.#cache.size > CAPACITY) this.#cache.delete(this.#cache.keys().next().value as string);
  }

  #fetch(id: string): Promise<ThreadDetail | null> {
    const epoch = this.#epoch;
    const existing = this.#inflight.get(id);
    if (existing && existing.epoch === epoch) return existing.p;
    const p = api
      .thread(id)
      .then((d) => {
        this.#put(d);
        if (epoch === this.#epoch) this.#stale.delete(id);
        else this.#stale.add(id);
        return d;
      })
      .catch((e) => {
        if (this.#wanted === id) this.error = e instanceof Error ? e.message : 'Could not load thread';
        return null;
      })
      .finally(() => {
        if (this.#inflight.get(id)?.p === p) this.#inflight.delete(id);
      });
    this.#inflight.set(id, { epoch, p });
    return p;
  }

  /** Fetch `id` again in the background and swap it in if it is still the one on screen. Never blanks it. */
  async #refresh(id: string): Promise<void> {
    const d = await this.#fetch(id);
    if (d && this.#wanted === id) this.current = d;
  }

  /**
   * Show a thread: instant when cached (and refreshed behind the scenes if it may be out of date), otherwise
   * fetched. The thread already on screen stays there while it is fetched again, so a live update never blanks it.
   */
  async show(id: string | null, _focus?: string): Promise<void> {
    this.#wanted = id;
    this.error = null;
    if (!id) {
      this.current = null;
      this.loading = false;
      return;
    }
    const hit = this.#cache.get(id);
    if (hit) {
      this.#put(hit);
      this.current = hit;
      this.loading = false;
      if (this.#stale.has(id)) await this.#refresh(id);
      return;
    }
    if (this.current?.threadId === id) return this.#refresh(id);
    this.current = null;
    this.loading = true;
    const d = await this.#fetch(id);
    if (this.#wanted === id) {
      this.current = d;
      this.loading = false;
    }
  }

  prefetch(id: string | null | undefined) {
    if (id && (!this.#cache.has(id) || this.#stale.has(id))) void this.#fetch(id);
  }

  /** Server told us something changed: cached threads may be stale. The one on screen is fetched again now. */
  invalidate() {
    this.#epoch++;
    for (const id of this.#cache.keys()) this.#stale.add(id);
    const id = this.#wanted;
    if (id && this.current?.threadId === id) void this.#refresh(id);
  }
}

export const thread = new ThreadStore();
