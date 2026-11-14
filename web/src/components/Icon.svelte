<script lang="ts">
  type Name =
    | 'inbox'
    | 'check'
    | 'layers'
    | 'list'
    | 'settings'
    | 'refresh'
    | 'search'
    | 'plus'
    | 'x'
    | 'reply'
    | 'video'
    | 'user'
    | 'channel'
    | 'playlist'
    | 'external'
    | 'chevron-left'
    | 'sidebar'
    | 'command'
    | 'alert'
    | 'sun'
    | 'moon'
    | 'trash'
    | 'undo'
    | 'check-all'
    | 'chart'
    | 'clock'
    | 'mic'
    | 'dismiss'
    | 'more'
    | 'chevron-up'
    | 'chevron-down';
  let { name, size = 16 }: { name: Name; size?: number } = $props();
  const paths: Record<Name, string> = {
    // A circle struck through: "nothing here for me". Deliberately unlike the check marks of Done and Replied.
    dismiss: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
    more: 'M3.6 12a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0-2.8 0M10.6 12a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0-2.8 0M17.6 12a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0-2.8 0',
    mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0m7 7v3',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    'chevron-up': 'M5 15l7-7 7 7',
    'chevron-down': 'M5 9l7 7 7-7',
    chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
    inbox:
      'M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5zm0 0h5l1 2h6l1-2h5',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    settings:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    refresh: 'M20 11a8 8 0 0 0-14.6-4.5L3 9m0-5v5h5M4 13a8 8 0 0 0 14.6 4.5L21 15m0 5v-5h-5',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3l-4.3-4.3',
    plus: 'M12 5v14M5 12h14',
    x: 'M6 6l12 12M18 6L6 18',
    reply: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v3',
    video: 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm14 4l4-2v8l-4-2',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    channel: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    playlist: 'M3 6h12M3 12h12M3 18h7m6-2V8l6 4-6 4z',
    external: 'M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    'chevron-left': 'M15 5l-7 7 7 7',
    sidebar: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm5 0v14',
    command: 'M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V9',
    alert: 'M12 9v4m0 4h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    undo: 'M9 14L4 9l5-5M4 9h9a6 6 0 0 1 0 12h-3',
    'check-all': 'M2 12.5l4.5 4.5L15 8.5M10 15l2 2 9-9',
    trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  style="flex: none"
>
  <path d={paths[name]} />
</svg>
