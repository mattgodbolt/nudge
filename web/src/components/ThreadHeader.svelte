<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { InboxItem } from '../../../shared/types';
  import { usage } from '../lib/usage';
  import { stateLabel } from '../lib/itemState';
  import { decisions } from '../lib/decisions';
  import { phone } from '../lib/phone.svelte';
  import { formatSnoozeTime, recentlyWoken } from '../lib/snooze';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import ItemActions from './ItemActions.svelte';
  import SnoozeNote from './SnoozeNote.svelte';
  import SuggestionChip from './SuggestionChip.svelte';
  import Icon from './Icon.svelte';

  let {
    item,
    now,
    view,
    actionsLabel,
    inlineFrom,
    title,
    meta,
    lead,
    extraTags,
    hasExtraTags = false,
    snoozedText,
    wokeText,
    showSuggestion = false,
    chrome = false,
  }: {
    item: InboxItem;
    now: number;
    /** Usage counter name, e.g. 'view.thread'. */
    view: string;
    actionsLabel: string;
    /** Header width at which the actions share the title row; below it they take a row of their own. */
    inlineFrom: number;
    /** The title element(s); the view owns their styling. */
    title: Snippet;
    /** The line under the title. */
    meta: Snippet;
    /** Rendered between the back button and the title block (e.g. a thumbnail). */
    lead?: Snippet;
    /** Badges shown after the state badge and before the snooze tag. */
    extraTags?: Snippet;
    /** Whether extraTags has anything to show, so the tag row is skipped when empty. */
    hasExtraTags?: boolean;
    /** Text of the snooze tag, given the formatted wake time. */
    snoozedText: (when: string) => string;
    wokeText: string;
    showSuggestion?: boolean;
    /** The comment thread's header styling: hidden back button on desktop, mobile layout, coloured snooze tag. */
    chrome?: boolean;
  } = $props();

  /** "Done", "Dismissed" ... once the item is dealt with; empty while it is in the inbox. */
  const stateText = $derived(stateLabel(item.comment));
  // Each thread is mounted once per open (the parent keys on it), so this counts opens, not renders.
  usage.count(untrack(() => view));
  // Opened now, closed when this thread unmounts or another item takes its place; dwell is measured in between.
  // Keyed on the id, not the row object, which a list refresh replaces: that would close and reopen the record.
  const itemId = $derived(item.comment.id);
  $effect(() =>
    decisions.open(
      itemId,
      untrack(() => inbox.viewName),
    ),
  );

  // The title block always gets the width it needs: the toolbar shares its row only in a roomy pane, and otherwise
  // takes a row of its own (it used to squeeze the title into a narrow column that wrapped to a dozen lines).
  let headerWidth = $state(1000);
  const inline = $derived(headerWidth >= inlineFrom);
  const woke = $derived(!item.snoozedUntil && item.comment.state === 'inbox' && recentlyWoken(item.wokeAt, now));
</script>

<header bind:clientWidth={headerWidth} class:chrome>
  <button class="btn ghost sm back" onclick={() => (ui.pane = 'list')} aria-label="Back to list"
    ><Icon name="chevron-left" size={phone.value ? 22 : 15} /> Back</button
  >
  {@render lead?.()}
  <div class="vt">
    {@render title()}
    {@render meta()}
    <SnoozeNote {item} />
    {#if item.snoozedUntil || woke || hasExtraTags || stateText}
      <div class="tags">
        {#if stateText}<span class="badge" data-testid="thread-state">{stateText}</span>{/if}
        {@render extraTags?.()}
        {#if item.snoozedUntil}
          <span class="snz" data-testid="thread-snoozed"
            >⏰ {snoozedText(formatSnoozeTime(item.snoozedUntil, new Date(now)))}</span
          >
        {:else if woke}
          <span class="snz" data-testid="thread-woke">⏰ {wokeText}</span>
        {/if}
      </div>
    {/if}
  </div>
  <ItemActions {item} width={headerWidth} ownRow={!inline} label={actionsLabel} />
  {#if showSuggestion && ui.showSuggestions && item.suggestion}<SuggestionChip
      suggestion={item.suggestion}
      testid="thread-suggestion"
      full
    />{/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s3) var(--s4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    min-height: 58px;
    flex-wrap: wrap;
  }
  .vt {
    min-width: 0;
    flex: 1;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    align-items: center;
    margin-top: 4px;
  }
  .chrome .tags {
    margin-top: 3px;
  }
  .chrome .snz {
    font-size: var(--fs-label);
    color: var(--secondary);
  }
  .chrome .back {
    display: none;
  }
  @media (max-width: 899px) {
    .chrome {
      padding: var(--s2) var(--s3) var(--s3);
      gap: var(--s2) var(--s3);
    }
    .chrome .back {
      display: inline-flex;
      flex-basis: calc(100% + var(--s5));
      height: 52px;
      justify-content: flex-start;
      gap: var(--s2);
      margin: calc(var(--s2) * -1) calc(var(--s3) * -1) 0;
      width: calc(100% + var(--s5));
      border-radius: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
      border-bottom: 1px solid var(--border);
    }
  }
</style>
