<script lang="ts">
  // Adventure mode's plumbing, mounted once with the app. It watches the inbox counts (read only) to know when to ask
  // for the sheet again, claims news when the tab comes back into view, and lets the chime's audio context start on the
  // first key or click. Off: it does nothing at all.
  import { untrack } from 'svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { rpg } from '../lib/stores/rpg.svelte';

  $effect(() => {
    if (rpg.enabled) untrack(() => void rpg.load());
    else untrack(() => rpg.clear());
  });

  // Every triage, snooze, undo, sync arrival and SSE update replaces the counts object. The first run is the boot,
  // which the effect above already covers.
  let first = true;
  $effect(() => {
    void inbox.counts;
    if (first) first = false;
    else untrack(() => rpg.poke());
  });

  $effect(() => {
    if (!rpg.sound) return;
    const onGesture = () => rpg.gesture();
    window.addEventListener('keydown', onGesture, { capture: true, passive: true });
    window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
    return () => {
      window.removeEventListener('keydown', onGesture, { capture: true });
      window.removeEventListener('pointerdown', onGesture, { capture: true });
    };
  });
</script>

<svelte:document
  onvisibilitychange={() => {
    if (document.visibilityState === 'visible') rpg.poke(0);
  }}
/>
