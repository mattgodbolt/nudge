import type { Binding } from './keymap.svelte';
import { router } from '../router.svelte';
import { inbox } from '../stores/inbox.svelte';
import { sync } from '../stores/sync.svelte';
import { theme } from '../stores/theme.svelte';
import { toasts } from '../stores/toasts.svelte';
import { ui } from '../stores/ui.svelte';

function open(url: string) {
  window.open(url, '_blank', 'noopener');
}

/** App-wide bindings; registered once from App.svelte. */
export function appBindings(): Binding[] {
  return [
    {
      id: 'palette.open',
      keys: ['$mod+k'],
      scope: 'global',
      group: 'App',
      description: 'Command palette',
      global: true,
      palette: false,
      run: () => {
        ui.helpOpen = false;
        ui.paletteOpen = !ui.paletteOpen;
      },
    },
    {
      id: 'help.open',
      keys: ['?'],
      scope: 'global',
      group: 'App',
      description: 'Keyboard shortcuts',
      run: () => (ui.helpOpen = true),
    },
    {
      id: 'go.inbox',
      keys: ['g i'],
      scope: 'global',
      group: 'Go to',
      description: 'Go to Inbox',
      run: () => router.navigate('inbox'),
    },
    {
      id: 'go.done',
      keys: ['g d'],
      scope: 'global',
      group: 'Go to',
      description: 'Go to Done',
      run: () => router.navigate('done'),
    },
    {
      id: 'go.all',
      keys: ['g a'],
      scope: 'global',
      group: 'Go to',
      description: 'Go to All',
      run: () => router.navigate('all'),
    },
    {
      id: 'go.sources',
      keys: ['g s'],
      scope: 'global',
      group: 'Go to',
      description: 'Go to Sources',
      run: () => router.navigate('sources'),
    },
    {
      id: 'go.settings',
      keys: ['g ,'],
      scope: 'global',
      group: 'Go to',
      description: 'Go to Settings',
      run: () => router.navigate('settings'),
    },
    {
      id: 'theme.cycle',
      keys: ['t'],
      scope: 'global',
      group: 'App',
      description: 'Cycle theme (system / light / dark)',
      run: () => theme.cycle(),
    },
    {
      id: 'sidebar.toggle',
      keys: ['['],
      scope: 'global',
      group: 'App',
      description: 'Toggle sidebar',
      run: () => ui.toggleSidebar(),
    },
    {
      id: 'sync.now',
      keys: ['s'],
      scope: 'global',
      group: 'App',
      description: 'Sync now',
      run: () => void sync.run({ scope: 'all' }),
    },
    {
      id: 'sync.deep',
      keys: ['S'],
      scope: 'global',
      group: 'App',
      description: 'Deep sync current video',
      run: () => {
        const v = inbox.selected?.video.id;
        if (!v) return void toasts.push({ message: 'Select a comment first', timeoutMs: 2500 });
        void sync.run({ scope: 'video', id: v, deep: true }, 'Deep sync started');
      },
    },
  ];
}

/** Bindings that only make sense while the inbox list/thread is on screen. */
export function inboxBindings(): Binding[] {
  const has = () => inbox.items.length > 0;
  const list = (b: Omit<Binding, 'scope'>): Binding => ({ ...b, scope: 'list' });
  return [
    list({
      id: 'nav.next',
      repeat: true,
      keys: ['j', 'ArrowDown'],
      group: 'Navigation',
      description: 'Next item',
      run: () => inbox.move(1),
    }),
    list({
      id: 'nav.prev',
      repeat: true,
      keys: ['k', 'ArrowUp'],
      group: 'Navigation',
      description: 'Previous item',
      run: () => inbox.move(-1),
    }),
    list({
      id: 'sel.extend-down',
      repeat: true,
      keys: ['J'],
      group: 'Navigation',
      description: 'Extend selection down',
      run: () => inbox.extendSelection(1),
    }),
    list({
      id: 'sel.extend-up',
      repeat: true,
      keys: ['K'],
      group: 'Navigation',
      description: 'Extend selection up',
      run: () => inbox.extendSelection(-1),
    }),
    list({
      id: 'sel.toggle',
      keys: ['x'],
      group: 'Navigation',
      description: 'Toggle select',
      when: has,
      run: () => inbox.toggleSelect(),
    }),
    list({
      id: 'thread.focus',
      keys: ['Enter', 'o'],
      group: 'Navigation',
      description: 'Open thread',
      when: () => !!inbox.selected,
      run: () => (ui.pane = 'thread'),
    }),
    list({
      id: 'list.escape',
      keys: ['Escape'],
      group: 'Navigation',
      description: 'Clear selection',
      palette: false,
      run: () => {
        if (inbox.selectedIds.size) inbox.clearSelection();
        else ui.pane = 'list';
      },
    }),
    list({
      id: 'triage.done',
      keys: ['e', 'd'],
      group: 'Triage',
      description: 'Mark done',
      when: () => !!inbox.selected,
      run: () => void inbox.triage('done'),
    }),
    list({
      id: 'triage.replied',
      keys: ['m'],
      group: 'Triage',
      description: 'Mark replied (without replying)',
      when: () => !!inbox.selected,
      run: () => void inbox.triage('replied'),
    }),
    list({
      id: 'triage.inbox',
      keys: ['u'],
      group: 'Triage',
      description: 'Move back to inbox',
      when: () => !!inbox.selected,
      run: () => void inbox.triage('inbox'),
    }),
    list({
      id: 'triage.undo',
      keys: ['z', '$mod+z'],
      group: 'Triage',
      description: 'Undo last action',
      run: () => void inbox.undo(),
    }),
    list({
      id: 'reply.open',
      keys: ['r'],
      group: 'Reply',
      description: 'Reply',
      when: () => !!inbox.selected,
      run: () => ui.openComposer(),
    }),
    list({
      id: 'open.comment',
      keys: ['v'],
      group: 'Reply',
      description: 'Open comment on YouTube',
      when: () => !!inbox.selected,
      run: () => open(inbox.selected!.comment.permalink),
    }),
    list({
      id: 'open.video',
      keys: ['V'],
      group: 'Reply',
      description: 'Open video on YouTube',
      when: () => !!inbox.selected,
      run: () => open(`https://www.youtube.com/watch?v=${encodeURIComponent(inbox.selected!.video.id)}`),
    }),
    list({ id: 'search.focus', keys: ['/'], group: 'Navigation', description: 'Search', run: () => ui.focusSearch() }),
    list({
      id: 'inbox.show-new',
      keys: ['.'],
      group: 'Navigation',
      description: 'Show new items',
      when: () => inbox.pendingCount > 0,
      run: () => void inbox.showPending(),
    }),
    list({
      id: 'filter.video',
      keys: ['g v'],
      group: 'Go to',
      description: 'Filter to current video',
      when: () => !!inbox.selected,
      run: () => router.setQuery({ video: inbox.selected!.video.id, c: undefined }, { replace: false }),
    }),
    list({
      id: 'filter.clear',
      keys: ['g c'],
      group: 'Go to',
      description: 'Clear filters',
      when: () => !!(router.query.source || router.query.video || router.query.q),
      run: () =>
        router.setQuery({ source: undefined, video: undefined, q: undefined, c: undefined }, { replace: false }),
    }),
    // Thread pane focus: j/k scroll the conversation instead of moving the list.
    {
      id: 'thread.down',
      repeat: true,
      keys: ['j', 'ArrowDown'],
      scope: 'thread',
      group: 'Navigation',
      description: 'Scroll thread down',
      palette: false,
      run: () => ui.scrollThread(1),
    },
    {
      id: 'thread.up',
      repeat: true,
      keys: ['k', 'ArrowUp'],
      scope: 'thread',
      group: 'Navigation',
      description: 'Scroll thread up',
      palette: false,
      run: () => ui.scrollThread(-1),
    },
    {
      id: 'thread.back',
      keys: ['Escape'],
      scope: 'thread',
      group: 'Navigation',
      description: 'Back to list',
      palette: false,
      run: () => (ui.pane = 'list'),
    },
  ];
}
