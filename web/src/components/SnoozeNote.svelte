<script lang="ts">
  import { untrack } from 'svelte';
  import { BUCKETS, nagText } from '../../../shared/snooze';
  import type { InboxItem } from '../../../shared/types';
  import { nudge } from '../lib/stores/nudge.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import Kbd from './Kbd.svelte';

  /**
   * What the open item says about its snooze: why (and the quiet reason bucket) while snoozed and once back, or, when it
   * came back because the wait ran out with no activity, the audit line with the choices that go with it. For a GitHub
   * item that was waiting on someone it also offers a drafted nudge to copy; nothing is ever posted.
   */
  let { item }: { item: InboxItem } = $props();

  const inInbox = $derived(item.comment.state === 'inbox');
  const nag = $derived(inInbox && !item.snoozedUntil ? item.snoozeNag : null);
  const bucket = $derived(item.snoozeBucket ? BUCKETS[item.snoozeBucket].label : null);
  const canNudge = $derived(
    !!nag &&
      item.item.provider === 'github' &&
      (nag.bucket === 'waiting_on_them' || nag.bucket === 'waiting_on_merge') &&
      !!settings.value?.llm.configured,
  );

  const mine = $derived(nudge.itemId === item.item.id);
  // Another item opening drops the previous item's draft.
  $effect(() => {
    const id = item.item.id;
    untrack(() => nudge.forgetUnless(id));
  });
</script>

{#if nag}
  <div class="nag" data-testid="thread-nag" role="status">
    <strong class="line" data-testid="thread-nag-text">{nagText(nag.bucket, nag.days)}</strong>
    {#if item.snoozeWhy}<div class="why faint" data-testid="thread-why">You snoozed this to: {item.snoozeWhy}</div>{/if}
    <div class="choices faint">
      <span><Kbd id="snooze.again" /> snooze again</span>
      <span><Kbd id="triage.done" /> done</span>
      <span><Kbd id="triage.dismiss" /> no action needed</span>
      <span><Kbd id="open.comment" /> open on {item.item.provider === 'github' ? 'GitHub' : 'YouTube'}</span>
    </div>
    {#if canNudge}
      <div class="nudge">
        <button
          class="btn sm"
          data-testid="nudge-draft"
          disabled={mine && nudge.busy}
          onclick={() => void nudge.make(item.item.id)}
          >{mine && nudge.busy ? 'Drafting…' : mine && nudge.text ? 'Draft another' : 'Draft a nudge'}</button
        >
        {#if mine && nudge.error}<span class="err meta" role="alert" data-testid="nudge-error">{nudge.error}</span>{/if}
      </div>
    {/if}
  </div>
{:else if inInbox && (item.snoozeWhy || bucket)}
  <div class="why faint" data-testid="thread-why">
    {#if item.snoozeWhy}You snoozed this to: {item.snoozeWhy}{/if}
    {#if bucket}<span class="bkt" data-testid="thread-bucket">{item.snoozeWhy ? ' · ' : 'Snoozed · '}{bucket}</span
      >{/if}
  </div>
{/if}

<style>
  /* What he said he would do on return: quiet, but never cut off. */
  .why {
    font-size: var(--fs-meta);
    font-style: italic;
    overflow-wrap: anywhere;
  }
  .bkt {
    font-style: normal;
  }
  .nag {
    display: flex;
    flex-direction: column;
    gap: var(--s1);
    margin: 4px 0;
    padding: var(--s2) var(--s3);
    border: 1px solid color-mix(in srgb, var(--warn) 55%, var(--border));
    border-left-width: 3px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--warn) 8%, var(--bg-elev));
  }
  .line {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1) var(--s3);
    font-size: var(--fs-meta);
  }
  .nudge {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    align-items: center;
  }
  .err {
    color: var(--danger);
  }
  /* Phone: the keys mean nothing there (the toolbar tiles do the same), and the buttons are thumb sized. */
  @media (max-width: 899px) {
    .choices {
      display: none;
    }
    .nudge .btn {
      min-height: 44px;
    }
  }
</style>
