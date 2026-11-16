import type { RpgSheet } from '../../../../shared/types';
import { api } from '../api';
import { playLevelUp, primeAudio } from '../levelSound';
import { browserTimeZone, newsToast } from '../rpg';
import { router } from '../router.svelte';
import { settings } from './settings.svelte';
import { toasts } from './toasts.svelte';

/** Wait this long after the inbox changes before asking again: a burst of triage becomes one request. */
export const RPG_DEBOUNCE_MS = 1200;

/**
 * Adventure mode in the browser (docs/RPG.md). It reads: the inbox never waits on it and nothing here can change an
 * item. Off means no request at all. Claims (which hand out the toasts) are only made while the tab is visible, so a
 * level-up is announced where someone can see it; a hidden tab just refreshes the sheet and claims when it comes back.
 */
class RpgStore {
  sheet = $state<RpgSheet | null>(null);
  /** Bumped on a level-up toast, for the chip's one small sparkle. */
  sparkle = $state(0);
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;
  #again = false;
  #generation = 0;

  get enabled(): boolean {
    return settings.value?.rpg?.enabled ?? false;
  }
  get sound(): boolean {
    return this.enabled && (settings.value?.rpg?.sound ?? false);
  }

  /** Mode switched off: forget everything and stop. */
  clear(): void {
    this.#generation++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.sheet = null;
  }

  /** Ask again soon (after inbox changes). */
  poke(delay = RPG_DEBOUNCE_MS): void {
    if (!this.enabled) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.load();
    }, delay);
  }

  async load(): Promise<void> {
    if (!this.enabled) return;
    if (this.#busy) {
      this.#again = true;
      return;
    }
    this.#busy = true;
    const gen = this.#generation;
    try {
      const tz = browserTimeZone();
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        const sheet = await api.rpg(tz);
        if (gen === this.#generation && this.enabled) this.sheet = sheet;
        return;
      }
      const { sheet, news } = await api.rpgClaim(tz);
      if (gen !== this.#generation || !this.enabled) return;
      this.sheet = sheet;
      const t = newsToast(news, sheet.day);
      if (t) {
        toasts.push({ message: t.message, timeoutMs: 8000 });
        if (t.ding) {
          this.sparkle++;
          if (this.sound) playLevelUp();
        }
      }
    } catch {
      // Decoration only: a failed fetch just leaves the chip as it was.
    } finally {
      this.#busy = false;
      if (this.#again) {
        this.#again = false;
        void this.load();
      }
    }
  }

  /** Called on the first key or click: the chime needs a gesture before it may play. */
  gesture(): void {
    if (this.sound) primeAudio();
  }

  async setTitle(level: number | null): Promise<void> {
    if (!settings.value) return;
    await settings.save({ rpg: { title: level } });
    void this.load();
  }

  /** The Hall of Heroes, at the bottom of Stats. */
  openHall(): void {
    router.navigate('stats');
    const scroll = (tries: number) => {
      const el = document.querySelector('[data-testid=hall]');
      if (el) el.scrollIntoView({ block: 'start' });
      else if (tries > 0) setTimeout(() => scroll(tries - 1), 100);
    };
    setTimeout(() => scroll(30), 0);
  }
}

export const rpg = new RpgStore();
