import { inbox } from './inbox.svelte';
import { load, save } from '../storage';

/** Ephemeral UI state shared between bindings and components. */
class UiStore {
  ownBannerDismissed = $state(load('yt-own-banner-dismissed', false));
  /** Hint chips with the model's suggestion on each row. A per-device display choice, so it lives in the browser. */
  showSuggestions = $state(load('nudge-show-suggestions', true));
  paletteOpen = $state(false);
  helpOpen = $state(false);
  sidebarCollapsed = $state(load('yt-sidebar-collapsed', false));
  listWidth = $state(load('yt-list-width', 420));
  /** Which pane has focus; on narrow screens it is the visible pane. */
  pane = $state<'list' | 'thread'>('list');
  composerOpen = $state(false);
  composerFocusTick = $state(0);
  searchFocusTick = $state(0);
  addSourceFocusTick = $state(0);
  threadScroll = $state({ delta: 0, tick: 0 });
  /** Comment ids the open snooze menu will act on (null = closed). */
  snoozeFor = $state<string[] | null>(null);
  /** The GitHub item the mute menu is open for (null = closed). */
  muteFor = $state<string | null>(null);

  dismissOwnBanner() {
    this.ownBannerDismissed = true;
    save('yt-own-banner-dismissed', true);
  }
  setShowSuggestions(on: boolean) {
    this.showSuggestions = on;
    save('nudge-show-suggestions', on);
  }
  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    save('yt-sidebar-collapsed', this.sidebarCollapsed);
  }
  setListWidth(w: number) {
    this.listWidth = Math.max(340, Math.min(640, Math.round(w)));
    save('yt-list-width', this.listWidth);
  }
  openComposer() {
    this.pane = 'thread';
    this.composerOpen = true;
    this.composerFocusTick++;
  }
  focusSearch() {
    this.searchFocusTick++;
  }
  /** Open the snooze menu for `ids`, or the multi-selection / cursor row. Ignored when there is nothing to act on. */
  openSnooze(ids = inbox.targetIds()) {
    if (ids.length === 0) return;
    this.helpOpen = false;
    this.paletteOpen = false;
    this.snoozeFor = ids;
  }
  /** Open the mute menu for a GitHub item (default: the cursor row). Ignored for other providers. */
  openMute(id = inbox.selectedId) {
    const item = id ? inbox.items.find((i) => i.comment.id === id) : undefined;
    if (!item || item.item.provider !== 'github') return;
    this.helpOpen = false;
    this.paletteOpen = false;
    this.muteFor = item.comment.id;
  }
  scrollThread(delta: number) {
    this.threadScroll = { delta, tick: this.threadScroll.tick + 1 };
  }
}

export const ui = new UiStore();
