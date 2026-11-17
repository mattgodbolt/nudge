<script lang="ts">
  import type { UsageDTO } from '../../../shared/usage';
  import { api } from '../lib/api';
  import { formatNumber } from '../lib/format';
  import { VIA_LABEL, featureLabel, formatMicros, summarise } from '../lib/usage-view';
  import { toasts } from '../lib/stores/toasts.svelte';

  let days = $state<7 | 30>(7);
  let dto = $state<UsageDTO | null>(null);
  let failed = $state(false);

  $effect(() => {
    const d = days;
    failed = false;
    // Only the answer for the window still chosen: 7 → 30 → 7 must not end on a late 30-day answer.
    api
      .usage(d)
      .then((r) => {
        if (d === days) dto = r;
      })
      .catch((e) => {
        if (d !== days) return;
        failed = true;
        toasts.fail(e, 'Could not load usage');
      });
  });

  const s = $derived(dto ? summarise(dto) : null);
  const topMax = $derived(Math.max(1, ...(s?.top.map((t) => t.count) ?? [1])));
  const dayMax = $derived(Math.max(1, ...(s?.perDay.map((d) => d.count) ?? [1])));
  const viaTotal = $derived(s ? s.via.kbd + s.via.btn + s.via.touch + s.via.palette : 0);
  const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
  const empty = $derived(!!s && s.total === 0 && s.events.length === 0);
</script>

<section class="usage" data-testid="usage-section" aria-label="Usage">
  <header class="head">
    <h2>Usage</h2>
    <span class="grow"></span>
    <div class="seg" role="group" aria-label="Window">
      <button class="btn sm" class:primary={days === 7} onclick={() => (days = 7)}>7 days</button>
      <button class="btn sm" class:primary={days === 30} onclick={() => (days = 30)}>30 days</button>
    </div>
  </header>
  <p class="meta muted">
    Counts of which features you use and how, kept in this server's database. Nothing you type or read is recorded.
  </p>

  {#if failed}
    <p class="meta muted">Usage could not be loaded.</p>
  {:else if !s || !dto}
    <p class="meta muted">Loading…</p>
  {:else}
    {#if empty}
      <p class="meta muted" data-testid="usage-empty">
        Nothing recorded in this window yet. Counts appear after a minute of use.
      </p>
    {/if}

    <div class="grid">
      <div class="panel pad block" data-testid="usage-top">
        <h3>Top features</h3>
        {#if s.top.length === 0}
          <p class="meta muted">None yet.</p>
        {:else}
          <ul class="bars">
            {#each s.top as t (t.feature)}
              <li>
                <span class="name truncate">{featureLabel(t.feature)}</span>
                <span class="track"><span class="fill" style:width="{pct(t.count, topMax)}%"></span></span>
                <span class="n">{formatNumber(t.count)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="panel pad block" data-testid="usage-via">
        <h3>How you do things</h3>
        {#if viaTotal === 0}
          <p class="meta muted">No actions yet.</p>
        {:else}
          <div class="stack" role="img" aria-label="Share of actions by input method">
            {#each ['kbd', 'btn', 'touch', 'palette'] as const as v (v)}
              {#if s.via[v] > 0}<span class="seg-{v}" style:flex-grow={s.via[v]}></span>{/if}
            {/each}
          </div>
          <ul class="legend">
            {#each ['kbd', 'btn', 'touch', 'palette'] as const as v (v)}
              <li>
                <span class="dot seg-{v}"></span>{VIA_LABEL[v]}
                <span class="n">{pct(s.via[v], viaTotal)}% · {formatNumber(s.via[v])}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="panel pad block" data-testid="usage-days">
        <h3>Per day</h3>
        <div class="days" role="img" aria-label="Feature uses per day">
          {#each s.perDay as d (d.day)}
            <span class="col" title="{d.day}: {formatNumber(d.count)}">
              <span class="bar" style:height="{pct(d.count, dayMax)}%"></span>
            </span>
          {/each}
        </div>
        <p class="meta muted">{formatNumber(s.total)} uses · days are UTC</p>
      </div>

      <div class="panel pad block" data-testid="usage-assistant">
        <h3>Tell Nudge</h3>
        <dl>
          <dt>Calls</dt>
          <dd>{formatNumber(s.assistant.calls)}</dd>
          <dt>Tool calls</dt>
          <dd>{formatNumber(s.assistant.toolCalls)}</dd>
          <dt>Failures</dt>
          <dd>{formatNumber(s.assistant.failures)}</dd>
          <dt>Spend</dt>
          <dd>{formatMicros(s.assistant.costMicros)}</dd>
          <dt>Dictations</dt>
          <dd>{formatNumber(s.assistant.voice)}</dd>
        </dl>
      </div>

      <div class="panel pad block" data-testid="usage-devices">
        <h3>Sessions and devices</h3>
        <dl>
          <dt>Sessions</dt>
          <dd>{formatNumber(s.sessions.started)}</dd>
          <dt>Active minutes</dt>
          <dd>{formatNumber(s.sessions.activeMinutes)}</dd>
          <dt>Phone / desktop</dt>
          <dd>{formatNumber(s.sessions.phone)} / {formatNumber(s.sessions.desktop)}</dd>
          <dt>App / browser tab</dt>
          <dd>{formatNumber(s.sessions.pwa)} / {formatNumber(s.sessions.browserTab)}</dd>
        </dl>
      </div>

      <div class="panel pad block" data-testid="usage-events">
        <h3>From the event log</h3>
        <p class="meta muted">What happened to items, counted from the event log rather than the browser.</p>
        {#if s.events.length === 0}
          <p class="meta muted">No events in this window.</p>
        {:else}
          <table class="grid-table">
            <thead>
              <tr><th>Kind</th><th class="num">You</th><th class="num">Auto</th><th class="num">Sync</th></tr>
            </thead>
            <tbody>
              {#each s.events as e (e.kind)}
                <tr>
                  <td>{featureLabel(e.kind)}</td>
                  <td class="num">{formatNumber(e.user)}</td>
                  <td class="num">{formatNumber(e.auto)}</td>
                  <td class="num">{formatNumber(e.sync)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>

    <div class="panel pad block" data-testid="usage-unused">
      <h3>Never used in this window</h3>
      {#if s.unused.length === 0}
        <p class="meta muted">Every feature was used at least once.</p>
      {:else}
        <p class="chips">
          {#each s.unused as f (f)}<span class="chip">{featureLabel(f)}</span>{/each}
        </p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .usage {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    margin-top: var(--s4);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s2);
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: var(--s2);
  }
  .grow {
    flex: 1;
  }
  .seg {
    display: flex;
    gap: var(--s1);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: var(--s3);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    min-width: 0;
  }
  .bars,
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bars li {
    display: grid;
    grid-template-columns: 9em 1fr 3.5em;
    align-items: center;
    gap: var(--s2);
    font-size: 12px;
  }
  .track {
    height: 8px;
    border-radius: 4px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
  }
  .n {
    text-align: right;
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }
  .stack {
    display: flex;
    height: 12px;
    border-radius: 6px;
    overflow: hidden;
    gap: 2px;
  }
  .stack span {
    flex-basis: 0;
  }
  /* Four categories, told apart by lightness and hue so the stack reads without the legend colours alone. */
  .seg-kbd {
    background: var(--accent);
  }
  .seg-btn {
    background: #3b82f6;
  }
  .seg-touch {
    background: #16a34a;
  }
  .seg-palette {
    background: #a1a1aa;
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: var(--s2);
    font-size: 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  .days {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 72px;
  }
  .col {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
  }
  .bar {
    display: block;
    width: 100%;
    min-height: 1px;
    background: var(--accent);
    border-radius: 2px 2px 0 0;
  }
  dl {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px var(--s3);
    margin: 0;
    font-size: 13px;
  }
  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  dt {
    opacity: 0.75;
  }
  .grid-table {
    width: 100%;
    font-size: 12px;
    border-collapse: collapse;
  }
  .grid-table th {
    text-align: left;
    font-weight: 500;
    opacity: 0.7;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1);
    margin: 0;
  }
  .chip {
    font-size: 12px;
    padding: 2px 8px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
  }
</style>
