import type { Capabilities, ImportMode, SettingsDTO } from '../../../../shared/types';
import type { SettingsUpdate } from '../../../../shared/api';
import { api } from '../api';
import { toasts } from './toasts.svelte';

class SettingsStore {
  value = $state<SettingsDTO | null>(null);
  capabilities = $state<Capabilities>({ canPost: false, postMode: 'handoff' });

  get needsKey(): boolean {
    return !!this.value && !this.value.demo && !this.value.apiKey.configured;
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
      toasts.error(e instanceof Error ? e.message : 'Could not remove that channel');
    }
  }

  async save(update: SettingsUpdate): Promise<boolean> {
    const prev = this.value;
    if (prev) {
      const { apiKey: _k, ...rest } = update;
      this.value = { ...prev, ...rest };
    }
    try {
      this.value = await api.saveSettings(update);
      return true;
    } catch (e) {
      this.value = prev;
      toasts.error(e instanceof Error ? e.message : 'Could not save settings');
      return false;
    }
  }
}

export const settings = new SettingsStore();
