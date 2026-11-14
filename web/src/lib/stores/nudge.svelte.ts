import { api } from '../api';

/**
 * The drafted nudge for the open item. One at a time: it belongs to the item it was asked for, and is dropped when
 * another item opens. It lives here (not in a component) because the button sits in the item's header and the draft
 * is shown in its body, where there is room for it on a phone.
 */
class NudgeStore {
  itemId = $state<string | null>(null);
  text = $state<string | null>(null);
  busy = $state(false);
  error = $state('');

  /** Ask for a draft for `itemId`; a draft for another item that arrives late is thrown away. */
  async make(itemId: string): Promise<void> {
    this.itemId = itemId;
    this.busy = true;
    this.error = '';
    try {
      const r = await api.nudgeDraft(itemId);
      if (this.itemId === itemId) this.text = r.text;
    } catch (e) {
      if (this.itemId === itemId) this.error = e instanceof Error ? e.message : 'Could not draft a nudge';
    } finally {
      if (this.itemId === itemId) this.busy = false;
    }
  }

  /** Another item opened: nothing carries over. */
  forgetUnless(itemId: string): void {
    if (this.itemId === itemId) return;
    this.itemId = null;
    this.text = null;
    this.busy = false;
    this.error = '';
  }
}

export const nudge = new NudgeStore();
