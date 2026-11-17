import { settings } from './settings.svelte';
import { loadRaw, saveRaw } from '../storage';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'yt-theme';

function stored(): ThemePref {
  const v = loadRaw(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

class ThemeStore {
  preference = $state<ThemePref>(stored());
  systemDark = $state(false);
  resolved = $derived<'light' | 'dark'>(
    this.preference === 'system' ? (this.systemDark ? 'dark' : 'light') : this.preference,
  );

  init() {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark = mq.matches;
    mq.addEventListener('change', (e) => {
      this.systemDark = e.matches;
      this.apply();
    });
    this.apply();
  }

  /** Called when settings arrive from the server (source of truth). */
  adopt(pref: ThemePref) {
    this.preference = pref;
    this.persist();
    this.apply();
  }

  private persist() {
    saveRaw(KEY, this.preference);
  }

  apply() {
    document.documentElement.dataset.theme = this.resolved;
  }

  set(pref: ThemePref) {
    this.preference = pref;
    this.persist();
    this.apply();
    void settings.save({ theme: pref });
  }

  cycle() {
    const order: ThemePref[] = ['system', 'light', 'dark'];
    this.set(order[(order.indexOf(this.preference) + 1) % order.length]!);
  }
}

export const theme = new ThemeStore();
