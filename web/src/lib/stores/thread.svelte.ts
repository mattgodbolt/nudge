import type { ThreadDetail } from '../../../../shared/types';
import { api } from '../api';

const CAPACITY = 50;

class ThreadStore {
  current = $state.raw<ThreadDetail | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  #cache = new Map<string, ThreadDetail>();
  #inflight = new Map<string, Promise<ThreadDetail | null>>();
  #wanted: string | null = null;

  get(id: string): ThreadDetail | undefined {
    return this.#cache.get(id);
  }

  #put(d: ThreadDetail) {
    this.#cache.delete(d.threadId);
    this.#cache.set(d.threadId, d);
    while (this.#cache.size > CAPACITY) this.#cache.delete(this.#cache.keys().next().value as string);
  }

  #fetch(id: string, focus?: string): Promise<ThreadDetail | null> {
    const existing = this.#inflight.get(id);
    if (existing) return existing;
    const p = api
      .thread(id, focus)
      .then((d) => {
        this.#put(d);
        return d;
      })
      .catch((e) => {
        if (this.#wanted === id) this.error = e instanceof Error ? e.message : 'Could not load thread';
        return null;
      })
      .finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, p);
    return p;
  }

  /** Show a thread; instant when cached, otherwise fetches. */
  async show(id: string | null, focus?: string): Promise<void> {
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
      return;
    }
    this.current = null;
    this.loading = true;
    const d = await this.#fetch(id, focus);
    if (this.#wanted === id) {
      this.current = d;
      this.loading = false;
    }
  }

  prefetch(id: string | null | undefined) {
    if (id && !this.#cache.has(id)) void this.#fetch(id);
  }

  /** Server told us something changed; cached threads may be stale. */
  invalidate() {
    this.#cache.clear();
  }
}

export const thread = new ThreadStore();
