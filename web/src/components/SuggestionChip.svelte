<script lang="ts">
  import type { SuggestionDTO } from '../../../shared/types';
  import { chipText, describe } from '../lib/suggestions';

  let {
    suggestion,
    testid = 'row-suggestion',
    full = false,
  }: { suggestion: SuggestionDTO; testid?: string; full?: boolean } = $props();
</script>

<!-- Advisory only: plain text, no click target, and nothing in the app reads it to decide anything. -->
<span
  class:full
  class="sug {suggestion.suspicious ? 'suspicious' : (suggestion.action ?? '')} conf-{suggestion.confidence}"
  title={describe(suggestion)}
  data-testid={testid}
  data-action={suggestion.action ?? 'suspicious'}
  data-confidence={suggestion.confidence}>{full ? describe(suggestion) : chipText(suggestion)}</span
>

<style>
  .sug {
    /* The video title and labels beside it give way first; only a very long reason is cut. */
    flex: 0 0 auto;
    max-width: 62%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-label);
    line-height: 14px;
    padding: 0 7px;
    border-radius: 999px;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  }
  .sug.reply {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .sug.suspicious {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 14%, transparent);
  }
  .sug.full {
    max-width: 100%;
    white-space: normal;
    line-height: 16px;
    padding: 1px 8px;
  }
  .conf-medium {
    opacity: 0.85;
  }
  .conf-low {
    opacity: 0.55;
  }
</style>
