import type { FeedDTO, ImportMode, MuteKind, MuteRuleDTO } from '../../../../shared/types';
import { api } from '../api';
import { inbox } from './inbox.svelte';
import { toasts } from './toasts.svelte';

/** Non-YouTube feeds (GitHub users and organisations) and the mute rules that quieten them. */
class FeedsStore {
  list = $state<FeedDTO[]>([]);
  mutes = $state<MuteRuleDTO[]>([]);
  loaded = $state(false);

  set(feeds: FeedDTO[], mutes: MuteRuleDTO[]) {
    this.list = feeds;
    this.mutes = mutes;
    this.loaded = true;
  }
  get(id: number): FeedDTO | undefined {
    return this.list.find((f) => f.id === id);
  }

  async add(owner: string, opts: { prs: boolean; issues: boolean; importMode: ImportMode }): Promise<boolean> {
    try {
      const f = await api.addFeed({ owner, ...opts });
      // The first poll's result may already have arrived over the event stream, and is newer than this response.
      if (!this.list.some((x) => x.id === f.id)) this.list = [...this.list, f];
      toasts.push({ message: `Added ${f.owner}`, kind: 'success', timeoutMs: 3500 });
      return true;
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not add feed');
      return false;
    }
  }

  async patch(id: number, patch: Partial<Pick<FeedDTO, 'enabled' | 'prs' | 'issues'>>) {
    const prev = this.list;
    this.list = this.list.map((f) => (f.id === id ? { ...f, ...patch } : f));
    try {
      const f = await api.patchFeed(id, patch);
      this.list = this.list.map((x) => (x.id === id ? f : x));
    } catch (e) {
      this.list = prev;
      toasts.error(e instanceof Error ? e.message : 'Could not update feed');
    }
  }

  async remove(id: number) {
    try {
      await api.deleteFeed(id);
      this.list = this.list.filter((f) => f.id !== id);
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not remove feed');
    }
  }

  async poll(id: number) {
    try {
      await api.pollFeed(id);
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not poll');
    }
  }

  /**
   * Mute a repo, an author, all bots or one item. What was in the inbox is archived and the list reloads; the toast's
   * Undo restores those items and removes the rule (the plain triage undo would leave the rule behind).
   */
  async mute(kind: MuteKind, value: string | undefined, label: string) {
    try {
      const { rule, triage } = await api.addMute(kind, value);
      this.mutes = [...this.mutes.filter((m) => m.id !== rule.id), rule];
      void inbox.load();
      toasts.push({
        message: `Muted ${label}`,
        kind: 'success',
        timeoutMs: 8000,
        action: {
          label: 'Undo',
          run: () => {
            void (async () => {
              try {
                if (triage) await api.undo(triage.actionId);
                await api.deleteMute(rule.id);
                this.mutes = this.mutes.filter((m) => m.id !== rule.id);
                void inbox.load();
              } catch (e) {
                toasts.error(e instanceof Error ? e.message : 'Could not undo the mute');
              }
            })();
          },
        },
      });
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not mute');
    }
  }

  async unmute(id: number) {
    try {
      await api.deleteMute(id);
      this.mutes = this.mutes.filter((m) => m.id !== id);
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not remove the mute');
    }
  }
}

export const feeds = new FeedsStore();
