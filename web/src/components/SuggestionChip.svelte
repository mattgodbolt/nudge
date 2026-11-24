<script lang="ts">
  import type { SuggestionDTO } from '../../../shared/types';
  import { chipText, describe, suggestionLines } from '../lib/suggestions';

  let {
    suggestion,
    testid = 'row-suggestion',
    full = false,
  }: { suggestion: SuggestionDTO; testid?: string; full?: boolean } = $props();

  const tone = $derived(
    suggestion.suspicious ? 'suspicious' : suggestion.turn === 'them' ? 'them' : (suggestion.action ?? ''),
  );
</script>

<!-- Advisory only: plain text, no click target, and nothing in the app reads it to decide anything. -->
{#if full}
  {@const lines = suggestionLines(suggestion)}
  <div
    class="block {tone} conf-{suggestion.confidence}"
    title={describe(suggestion)}
    data-testid={testid}
    data-action={suggestion.action ?? 'suspicious'}
    data-turn={suggestion.turn ?? ''}
    data-confidence={suggestion.confidence}
  >
    <div class="lead">{lines.lead}</div>
    <div class="why">{lines.why}</div>
  </div>
{:else}
  <span
    class="sug {tone} conf-{suggestion.confidence}"
    title={describe(suggestion)}
    data-testid={testid}
    data-action={suggestion.action ?? 'suspicious'}
    data-turn={suggestion.turn ?? ''}
    data-confidence={suggestion.confidence}
  >
    {chipText(suggestion)}
  </span>
{/if}

<style>
  /* On a row: one quiet line of text with the whole row's width to use, cut with an ellipsis only when it must be. */
  .sug {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-label);
    line-height: 16px;
    color: var(--text-muted);
  }
  .sug.reply,
  .block.reply .lead {
    color: var(--success);
  }
  .sug.suspicious,
  .block.suspicious .lead {
    color: var(--warn);
  }
  /* In the open item's header: a full-width block under the title, never clipped, wrapping as it needs. */
  .block {
    flex: 1 0 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: var(--s2) var(--s3);
    border-radius: var(--radius);
    border-left: 3px solid var(--border-strong);
    background: color-mix(in srgb, var(--text-muted) 8%, transparent);
    overflow-wrap: anywhere;
  }
  .block.reply {
    border-left-color: var(--success);
  }
  .block.suspicious {
    border-left-color: var(--warn);
  }
  .block .lead {
    font-size: var(--fs-meta);
    line-height: 1.4;
    color: var(--text);
  }
  .block .why {
    margin-top: 2px;
    font-size: var(--fs-label);
    line-height: 1.4;
    color: var(--text-faint);
  }
  .conf-medium {
    opacity: 0.85;
  }
  .conf-low {
    opacity: 0.6;
  }
</style>
