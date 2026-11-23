<script lang="ts">
  import { ui } from '../lib/stores/ui.svelte';
  import OwnChannelForm from './OwnChannelForm.svelte';
  import Icon from './Icon.svelte';
</script>

<aside class="banner" data-testid="own-channel-banner">
  <div class="body">
    <strong>Which channel is yours?</strong>
    <span class="muted meta">Paste your channel URL or @handle so your own comments stay out of the inbox.</span>
    <OwnChannelForm />
  </div>
  <button class="btn ghost sm" aria-label="Dismiss" onclick={() => ui.dismissOwnBanner()}>
    <Icon name="x" size={14} />
  </button>
</aside>

<style>
  .banner {
    display: flex;
    gap: var(--s3);
    align-items: flex-start;
    padding: var(--s3) var(--s4);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--border);
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    max-width: 640px;
  }
</style>
