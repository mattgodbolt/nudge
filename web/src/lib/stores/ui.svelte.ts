/** Ephemeral UI state shared between bindings and components. */
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

class UiStore {
  ownBannerDismissed = $state(load('yt-own-banner-dismissed', false));
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

  dismissOwnBanner() {
    this.ownBannerDismissed = true;
    save('yt-own-banner-dismissed', true);
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
  scrollThread(delta: number) {
    this.threadScroll = { delta, tick: this.threadScroll.tick + 1 };
  }
}

export const ui = new UiStore();
