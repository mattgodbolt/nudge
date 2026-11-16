import { api } from '../api';
import { inbox } from './inbox.svelte';
import { toasts } from './toasts.svelte';

const DEBOUNCE_MS = 500;

class DraftStore {
  /** Local mirror: commentId -> body. */
  bodies = $state<Record<string, string>>({});
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #loaded = new Set<string>();
  /** Drafts whose last save failed: told once, until a save works again. */
  #unsaved = new Set<string>();

  /** Load the server draft once (resolves to the current body, '' when none). */
  async load(id: string): Promise<string> {
    if (!this.#loaded.has(id)) {
      this.#loaded.add(id);
      try {
        const d = await api.getDraft(id);
        if (d && this.bodies[id] === undefined) this.bodies[id] = d.body;
      } catch {
        this.#loaded.delete(id);
      }
    }
    return this.bodies[id] ?? '';
  }

  set(id: string, body: string) {
    this.bodies[id] = body;
    this.#loaded.add(id);
    inbox.setHasDraft(id, body.trim().length > 0);
    const t = this.#timers.get(id);
    if (t) clearTimeout(t);
    this.#timers.set(
      id,
      setTimeout(() => void this.flush(id), DEBOUNCE_MS),
    );
  }

  async flush(id: string) {
    const t = this.#timers.get(id);
    if (t) clearTimeout(t);
    this.#timers.delete(id);
    const body = this.bodies[id];
    if (body === undefined) return;
    try {
      if (body.trim()) await api.putDraft(id, body);
      else await api.deleteDraft(id);
      this.#unsaved.delete(id);
    } catch (e) {
      // The text is still here, but only in this tab: a reload would lose it, so say so (once, not per keystroke).
      if (!this.#unsaved.has(id) && body.trim()) {
        this.#unsaved.add(id);
        toasts.error(
          `Couldn't save the draft (${e instanceof Error ? e.message : 'network error'}): it is only in this tab`,
        );
      }
    }
  }

  /**
   * Stop auto-saving a draft while its reply is in flight, so a late debounce can't resurrect a draft
   * the server just cleared. The text stays in the store until the send is confirmed (discard) or fails (restore).
   */
  hold(id: string) {
    const t = this.#timers.get(id);
    if (t) clearTimeout(t);
    this.#timers.delete(id);
  }

  /** The send failed: put the text back (unless the user has typed something new) and persist it again. */
  restore(id: string, body: string) {
    if (!(this.bodies[id] ?? '').trim()) this.bodies[id] = body;
    this.#loaded.add(id);
    inbox.setHasDraft(id, (this.bodies[id] ?? '').trim().length > 0);
    void this.flush(id);
  }

  /** Forget a draft locally (after the server confirmed the send); the server clears it on reply. */
  discard(id: string) {
    const t = this.#timers.get(id);
    if (t) clearTimeout(t);
    this.#timers.delete(id);
    delete this.bodies[id];
    this.#loaded.add(id);
    inbox.setHasDraft(id, false);
  }
}

export const drafts = new DraftStore();
