<script lang="ts">
  // A number that is the whole story: label · value · a line of context, and optionally a link to the item.
  let {
    value,
    sub = null,
    href = null,
    linkText = null,
    onopen,
  }: {
    value: string;
    sub?: string | null;
    href?: string | null;
    linkText?: string | null;
    onopen?: () => void;
  } = $props();
</script>

<div class="tile">
  <span class="value" data-testid="stat-value">{value}</span>
  {#if sub}<span class="sub">{sub}</span>{/if}
  {#if href && linkText}
    <a
      class="link truncate"
      {href}
      title={linkText}
      onclick={(e) => {
        if (onopen) {
          e.preventDefault();
          onopen();
        }
      }}>{linkText}</a
    >
  {/if}
</div>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .value {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  .sub {
    font-size: 12px;
    color: var(--text-muted);
  }
  .link {
    font-size: 12px;
    color: inherit;
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 2px;
    max-width: 100%;
  }
</style>
