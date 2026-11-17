import type { Capabilities, GoogleAuthDTO, ImportMode, SettingsDTO } from '../../../../shared/types';
import type { SettingsUpdate } from '../../../../shared/api';
import { api } from '../api';
import { toasts } from './toasts.svelte';
import { loadRaw, saveRaw } from '../storage';

const SKIP_KEY = 'nudge.skipYoutubeKey';
/** Per browser, like the theme: whether this browser has been told "I do not use YouTube". Storage may be blocked. */
function readSkip(): boolean {
  return loadRaw(SKIP_KEY) === '1';
}

class SettingsStore {
  value = $state<SettingsDTO | null>(null);
  /** The owner chose to use Nudge without a YouTube key (GitHub feeds and todos need none). */
  skippedYoutube = $state(readSkip());
  capabilities = $state<Capabilities>({ canPost: false, postMode: 'handoff' });

  get needsKey(): boolean {
    return !!this.value && !this.value.demo && !this.value.apiKey.configured && !this.skippedYoutube;
  }

  skipYoutube() {
    this.skippedYoutube = true;
    saveRaw(SKIP_KEY, '1'); // with storage blocked the choice lasts until the page reloads
  }

  /** Real mode with a key but no channel marked as mine: time to ask which one is. */
  get needsOwnChannel(): boolean {
    return !!this.value && !this.value.demo && this.value.apiKey.configured && this.value.ownChannelIds.length === 0;
  }

  /** Resolve a pasted URL / @handle / UC id and register it as mine. Returns an error message, or null on success. */
  async addOwnChannel(input: string, importMode?: ImportMode): Promise<string | null> {
    try {
      this.value = await api.addOwnChannel(input, importMode);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not add that channel';
    }
  }
  async removeOwnChannel(id: string): Promise<void> {
    try {
      this.value = await api.removeOwnChannel(id);
    } catch (e) {
      toasts.fail(e, 'Could not remove that channel');
    }
  }

  #setGoogle(google: GoogleAuthDTO) {
    if (this.value) this.value = { ...this.value, google };
  }

  /** Paste of the downloaded client JSON (or null to remove it). Returns an error message, or null on success. */
  async saveGoogleClient(json: string | null): Promise<string | null> {
    try {
      this.value = await api.saveSettings({ googleClient: json === null ? null : { json } });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not save the Google client';
    }
  }

  /** Starts the consent flow in this tab; the page reboots when Google redirects back. */
  async connectGoogle(): Promise<boolean> {
    try {
      const { url } = await api.authStart();
      window.location.assign(url);
      return true;
    } catch (e) {
      toasts.fail(e, 'Could not start Google sign-in');
      return false;
    }
  }

  async disconnectGoogle(channelId?: string): Promise<void> {
    try {
      this.#setGoogle(await api.authLogout(channelId));
    } catch (e) {
      toasts.fail(e, 'Could not disconnect');
    }
  }

  async setDefaultGoogle(channelId: string): Promise<void> {
    try {
      this.#setGoogle(await api.authDefault(channelId));
    } catch (e) {
      toasts.fail(e, 'Could not change the default channel');
    }
  }

  async save(update: SettingsUpdate): Promise<boolean> {
    const prev = this.value;
    if (prev) {
      const { apiKey: _k, github: _g, llm: _l, owner, snoozeDays, rpg, ...rest } = update;
      this.value = {
        ...prev,
        ...rest,
        ...(snoozeDays ? { snoozeDays: { ...prev.snoozeDays, ...snoozeDays } } : {}),
        ...(rpg ? { rpg: { ...prev.rpg, ...rpg } } : {}),
        ...(owner ? { owner: { ...prev.owner, ...owner } } : {}),
      };
    }
    try {
      this.value = await api.saveSettings(update);
      return true;
    } catch (e) {
      this.value = prev;
      toasts.fail(e, 'Could not save settings');
      return false;
    }
  }
}

export const settings = new SettingsStore();
