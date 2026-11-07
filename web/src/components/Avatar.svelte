<script lang="ts">
  let { url, name, size = 24 }: { url: string | null; name: string; size?: number } = $props();
  let failed = $state(false);
  const initial = $derived((name.replace(/^@/, '').trim()[0] ?? '?').toUpperCase());
  const hue = $derived([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
</script>

{#if url && !failed}
  <img
    src={url}
    alt=""
    width={size}
    height={size}
    loading="lazy"
    referrerpolicy="no-referrer"
    onerror={() => (failed = true)}
    style:width="{size}px"
    style:height="{size}px"
  />
{:else}
  <span
    class="fallback"
    style:width="{size}px"
    style:height="{size}px"
    style:font-size="{size * 0.46}px"
    style:background="hsl({hue} 35% 45%)">{initial}</span
  >
{/if}

<style>
  img,
  .fallback {
    border-radius: 50%;
    flex: none;
    object-fit: cover;
    background: var(--bg-hover);
  }
  .fallback {
    display: inline-grid;
    place-items: center;
    color: #fff;
    font-weight: 600;
  }
</style>
