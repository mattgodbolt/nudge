<script lang="ts">
  import {
    BUCKETS,
    DEFAULT_SNOOZE_DAYS,
    SNOOZE_BUCKETS,
    fallbackDate,
    type SnoozeBucket,
  } from '../../../shared/snooze';
  import { keymap } from '../lib/keys/keymap.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { usage } from '../lib/usage';
  import {
    defaultCustomTime,
    formatSnoozeTime,
    fromLocalInputValue,
    snoozePresets,
    toLocalInputValue,
    type SnoozePreset,
  } from '../lib/snooze';
  import { pluralize } from '../lib/format';
  import Kbd from './Kbd.svelte';
  import { fade } from 'svelte/transition';
  import { tick } from 'svelte';

  const CUSTOM = 4; // index of "Pick date & time…"
  const ACTIVITY = 5; // index of "Until activity"

  let presets = $state<SnoozePreset[]>([]);
  let now = $state(new Date());
  let active = $state(0);
  let custom = $state('');
  let error = $state('');
  let dialog: HTMLDivElement | undefined = $state();
  let customInput: HTMLInputElement | undefined = $state();
  let whyInput: HTMLInputElement | undefined = $state();
  /** Optional one line: why, or what to do on return. Shown back when the item wakes. */
  let why = $state('');
  /** Why it is parked (optional): one key or tap. Applies to whichever way of snoozing is picked next. */
  let bucket = $state<SnoozeBucket | null>(null);
  /** Also come back on activity: the time picked becomes the fallback instead of the only wake-up. */
  let wake = $state(false);

  const days = $derived(settings.value?.snoozeDays ?? DEFAULT_SNOOZE_DAYS);
  /** What "Until activity" falls back to, for the bucket picked so far. */
  const fallbackDays = $derived(bucket ? days[bucket] : 7);

  function close() {
    ui.snoozeFor = null;
  }

  async function snoozeAt(at: Date, how: 'preset' | 'custom' | 'activity', untilActivity = wake) {
    const ids = ui.snoozeFor;
    if (!ids) return;
    if (at.getTime() <= Date.now()) {
      error = 'Pick a time in the future';
      return;
    }
    usage.count(how === 'activity' ? 'snooze.until_activity' : `snooze.${how}`);
    if (untilActivity && how !== 'activity') usage.count('snooze.until_activity');
    if (bucket) usage.count('snooze.bucket');
    const reason = why.trim();
    const picked = bucket;
    close();
    // The date is shown as the fallback when it is waiting on activity: "activity (or Fri 8:00 AM)".
    const when = formatSnoozeTime(at, now);
    await inbox.snooze(at, ids, untilActivity ? `activity (or ${when})` : when, reason || undefined, {
      bucket: picked,
      untilActivity,
    });
  }

  function pickBucket(b: SnoozeBucket) {
    bucket = bucket === b ? null : b;
  }

  function choose(i: number) {
    if (i === ACTIVITY) {
      void snoozeAt(fallbackDate(new Date(), bucket, days), 'activity', true);
      return;
    }
    if (i === CUSTOM) {
      active = CUSTOM;
      void tick().then(() => customInput?.focus());
      return;
    }
    const p = presets[i];
    if (p) void snoozeAt(p.at, 'preset');
  }

  function confirmCustom() {
    const d = fromLocalInputValue(custom);
    if (!d) error = 'Pick a date and time';
    else void snoozeAt(d, 'custom');
  }
  // The label's days follow the bucket, so the row says what will happen before it is pressed.

  function enter() {
    if (active === CUSTOM) confirmCustom();
    else choose(active);
  }

  $effect(() => {
    if (!ui.snoozeFor) return;
    // Use a local: reading `now` back after assigning it would make this effect depend on itself.
    const n = new Date();
    now = n;
    presets = snoozePresets(n);
    custom = toLocalInputValue(defaultCustomTime(n));
    active = 0;
    error = '';
    why = '';
    bucket = null;
    wake = false;
    void tick().then(() => dialog?.focus());
    const unscope = keymap.pushScope('modal');
    const bind = (id: string, keys: string[], run: () => void, repeat = false) => ({
      id: `snooze.menu.${id}`,
      keys,
      scope: 'modal' as const,
      group: 'App' as const,
      description: 'Snooze menu',
      palette: false,
      repeat,
      run,
    });
    const unreg = keymap.register([
      bind('close', ['Escape'], close),
      bind('down', ['ArrowDown', 'j'], () => (active = Math.min(active + 1, ACTIVITY)), true),
      bind('up', ['ArrowUp', 'k'], () => (active = Math.max(active - 1, 0)), true),
      bind('enter', ['Enter'], enter),
      // Skipping the reason costs nothing; Tab is the way in to it from the keyboard.
      bind('why', ['Tab'], () => whyInput?.focus()),
      ...['1', '2', '3', '4', '5', '6'].map((k, i) => bind(`n${k}`, [k], () => choose(i))),
      // Letters pick why it is parked; u also wakes it early on activity. None of them snoozes by itself.
      ...SNOOZE_BUCKETS.map((b) => bind(`bucket.${b}`, [BUCKETS[b].key], () => pickBucket(b))),
      bind('wake', ['u'], () => (wake = !wake)),
    ]);
    return () => {
      unreg();
      unscope();
    };
  });

  const count = $derived(ui.snoozeFor?.length ?? 0);
</script>

{#if ui.snoozeFor}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" transition:fade={{ duration: 100 }} onclick={close}>
    <div
      class="menu panel"
      data-testid="snooze-menu"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Snooze"
      bind:this={dialog}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="head">
        <strong>Snooze</strong>
        <span class="faint meta">{count > 1 ? pluralize(count, 'comment') : 'until…'}</span>
      </div>
      <div class="opts" role="listbox" aria-label="Snooze until">
        {#each presets as p, i (p.id)}
          <button
            type="button"
            class="opt"
            class:active={active === i}
            role="option"
            aria-selected={active === i}
            data-testid="snooze-{p.id}"
            onmousemove={() => (active = i)}
            onclick={() => choose(i)}
          >
            <span class="grow">{p.label}</span>
            <span class="when faint">{formatSnoozeTime(p.at, now)}</span>
            <Kbd label={String(i + 1)} />
          </button>
        {/each}
        <button
          type="button"
          class="opt"
          class:active={active === CUSTOM}
          role="option"
          aria-selected={active === CUSTOM}
          data-testid="snooze-custom"
          onmousemove={() => (active = CUSTOM)}
          onclick={() => choose(CUSTOM)}
        >
          <span class="grow">Pick date &amp; time…</span>
          <Kbd label="5" />
        </button>
        {#if active === CUSTOM}
          <div class="custom">
            <input
              bind:this={customInput}
              bind:value={custom}
              type="datetime-local"
              class="input"
              aria-label="Snooze until"
              data-testid="snooze-datetime"
              oninput={() => (error = '')}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmCustom();
                }
              }}
            />
            <button type="button" class="btn primary" data-testid="snooze-confirm" onclick={confirmCustom}
              >Snooze</button
            >
          </div>
        {/if}
        <button
          type="button"
          class="opt"
          class:active={active === ACTIVITY}
          role="option"
          aria-selected={active === ACTIVITY}
          data-testid="snooze-activity"
          onmousemove={() => (active = ACTIVITY)}
          onclick={() => choose(ACTIVITY)}
        >
          <span class="grow">Until activity</span>
          <span class="when faint" data-testid="snooze-activity-days">or {fallbackDays}d</span>
          <Kbd label="6" />
        </button>
      </div>
      <div class="reasons" role="group" aria-label="Why it is parked (optional)" data-testid="snooze-reasons">
        <span class="faint meta lbl">Why</span>
        {#each SNOOZE_BUCKETS as b (b)}
          <button
            type="button"
            class="chip"
            class:on={bucket === b}
            aria-pressed={bucket === b}
            data-testid="snooze-bucket-{b}"
            onclick={() => pickBucket(b)}
          >
            <span>{BUCKETS[b].label}</span>
            <span class="kbd-hint"><Kbd label={BUCKETS[b].key} /></span>
          </button>
        {/each}
        <button
          type="button"
          class="chip wake"
          class:on={wake}
          aria-pressed={wake}
          data-testid="snooze-wake"
          title="Come back as soon as someone else comments, merges or replies. The time you pick is the fallback."
          onclick={() => (wake = !wake)}
        >
          <span>Also wake on activity</span>
          <span class="kbd-hint"><Kbd label="u" /></span>
        </button>
      </div>
      <div class="why">
        <input
          bind:this={whyInput}
          bind:value={why}
          type="text"
          class="input"
          maxlength="200"
          placeholder="Why? What to do on return (optional)"
          aria-label="Why you are snoozing (optional)"
          autocomplete="off"
          enterkeyhint="done"
          data-testid="snooze-why"
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              enter();
            }
          }}
        />
        <span class="kbd-hint"><Kbd label="Tab" /></span>
      </div>
      {#if error}<p class="err meta" role="alert">{error}</p>{/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 70;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 14vh var(--s4) 0;
  }
  .menu {
    width: min(360px, 100%);
    box-shadow: var(--shadow-pop);
    padding: var(--s1);
    outline: none;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: var(--s2) var(--s3);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: var(--s3);
    width: 100%;
    padding: 8px var(--s3);
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .opt.active {
    background: var(--bg-hover);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .when {
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }
  .custom {
    display: flex;
    gap: var(--s2);
    padding: var(--s1) var(--s3) var(--s2);
  }
  .custom .input {
    flex: 1;
  }
  .why {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s1) var(--s3) var(--s2);
  }
  .why .input {
    flex: 1;
    min-width: 0;
  }
  .reasons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s1) var(--s2);
    padding: var(--s1) var(--s3) var(--s1);
  }
  .reasons .lbl {
    width: 100%;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    padding: 3px var(--s2);
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .chip:hover {
    background: var(--bg-hover);
  }
  .chip.on {
    border-color: var(--accent);
    background: var(--bg-hover);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .chip.wake {
    border-style: dashed;
  }
  .err {
    padding: 0 var(--s3) var(--s2);
    color: var(--danger);
  }
  /* Phone: a bottom sheet, full width, safe-area aware, thumb-reachable. */
  @media (max-width: 899px) {
    .scrim {
      align-items: flex-end;
      padding: 0;
    }
    .menu {
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      border-bottom: 0;
      padding-bottom: env(safe-area-inset-bottom);
      animation: sheet-up 180ms var(--ease);
    }
    .opt {
      min-height: 52px;
      padding: 8px var(--s4);
      font-size: 16px;
    }
    .head {
      padding: var(--s3) var(--s4) var(--s2);
    }
    .custom {
      padding: var(--s2) var(--s4) var(--s3);
    }
    .reasons {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--s2);
      padding: var(--s2) var(--s4) var(--s1);
    }
    .reasons .chip {
      min-height: 44px;
      justify-content: center;
      font-size: 15px;
      border-radius: var(--radius);
      text-align: center;
    }
    .reasons .chip.wake,
    .reasons .lbl {
      grid-column: 1 / -1;
    }
    .why {
      padding: var(--s2) var(--s4) var(--s3);
    }
    .why .input {
      font-size: 16px; /* anything smaller makes iOS zoom the page on focus */
      min-height: 44px;
    }
    .kbd-hint {
      display: none;
    }
    @keyframes sheet-up {
      from {
        transform: translateY(40px);
        opacity: 0;
      }
    }
  }
</style>
