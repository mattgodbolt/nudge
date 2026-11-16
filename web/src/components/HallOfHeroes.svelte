<script lang="ts">
  // The Hall of Heroes: Adventure mode's character sheet, at the bottom of Stats. Everything here is after the fact;
  // nothing in it is shown anywhere a decision about an item is made.
  import { tierFor } from '../../../shared/rpg';
  import { rpg } from '../lib/stores/rpg.svelte';
  import { campfireLine, campfireSummary, chipLabel, dayName, xpFraction, xpLine } from '../lib/rpg';
  import RpgArt from './RpgArt.svelte';

  const s = $derived(rpg.sheet);
  const earnedCount = $derived(s ? s.achievements.filter((a) => a.earned).length : 0);
</script>

{#if rpg.enabled}
  <section class="panel hall" id="hall" data-testid="hall" aria-labelledby="hall-h">
    <h2 id="hall-h">Hall of Heroes</h2>
    {#if !s}
      <p class="meta muted">Consulting the scrolls…</p>
    {:else}
      <div class="hero">
        <div class="portrait">
          <RpgArt kind="avatar" id={tierFor(s.level)} size={72} label="{s.levelTitle}, level {s.level}" />
        </div>
        <div class="stats">
          <div class="name" data-testid="hall-title">{chipLabel(s)}</div>
          <div class="bar accent-{s.accent}" aria-hidden="true">
            <span class="fill" style="width: {xpFraction(s) * 100}%"></span>
          </div>
          <div class="meta muted" data-testid="hall-xp">{xpLine(s)}</div>
          <div class="meta muted">
            {s.tally.replies} replies · {s.tally.dones} done · {s.tally.dismissals} dismissed
          </div>
          {#each campfireSummary(s) as line (line)}<div class="meta" data-testid="hall-campfire">{line}</div>{/each}
          {#if s.campfire.notice}
            <div class="meta notice" data-testid="hall-campfire-notice">{campfireLine(s.campfire.notice, s.day)}</div>
          {/if}
        </div>
      </div>

      {#if s.titles.length > 1}
        <label class="picker meta">
          <span>Title shown</span>
          <select
            data-testid="hall-title-picker"
            value={s.chosenTitle === null ? '' : String(s.chosenTitle)}
            onchange={(e) => {
              const v = e.currentTarget.value;
              void rpg.setTitle(v === '' ? null : Number(v));
            }}
          >
            <option value="">The current level's ({s.levelTitle})</option>
            {#each s.titles as t (t.level)}
              <option value={String(t.level)}>Lv {t.level}: {t.title}</option>
            {/each}
          </select>
        </label>
      {/if}

      <h3>Trophies</h3>
      <ul class="grid bosses">
        {#each s.bosses as b (b.id)}
          <li class="card" class:dim={b.defeated === 0} data-testid="hall-boss">
            <RpgArt kind="boss" id={b.id} size={44} silhouette={b.defeated === 0} label={b.name} />
            <div class="cap">
              <strong>{b.name}</strong>
              <span class="meta muted">{b.who}</span>
              {#if b.defeated > 0}
                <span class="meta"
                  >Fallen {b.defeated === 1 ? 'once' : `${b.defeated} times`}{b.firstOn
                    ? `, first ${dayName(b.firstOn, s.day)}`
                    : ''}</span
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>

      <h3>Achievements <span class="meta muted">{earnedCount} of {s.achievements.length}</span></h3>
      <ul class="grid badges">
        {#each s.achievements as a (a.id)}
          <li class="card" class:dim={!a.earned} data-testid="hall-achievement" data-earned={a.earned}>
            <RpgArt
              kind="badge"
              id={a.name ? a.id : 'unknown'}
              size={40}
              silhouette={!a.earned}
              label={a.name ?? 'Hidden'}
            />
            <div class="cap">
              <strong>{a.name ?? '???'}</strong>
              <span class="meta muted">{a.description ?? 'A secret, for now.'}</span>
              {#if a.earned && a.earnedOn}
                <span class="meta">Earned {dayName(a.earnedOn, s.day)}</span>
              {:else if a.progress}
                <span class="meta muted">{a.progress.n} of {a.progress.of}</span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>

      <h3>Loot</h3>
      <ul class="grid loot">
        {#each s.loot as l (l.id)}
          <li class="card" class:dim={!l.earned} data-testid="hall-loot">
            <RpgArt kind="loot" id={l.id} size={36} silhouette={!l.earned} label={l.name} />
            <div class="cap">
              <strong>{l.name}</strong>
              <span class="meta muted">{l.description}</span>
              {#if l.times > 1}<span class="meta">×{l.times}</span>{/if}
            </div>
          </li>
        {/each}
      </ul>

      {#if s.lootLog.length > 0}
        <h3>Loot log</h3>
        <ul class="log meta" data-testid="hall-loot-log">
          {#each s.lootLog.slice(0, 10) as x, i (i)}
            <li>Found {x.name} <span class="muted">· {dayName(x.on, s.day)}</span></li>
          {/each}
        </ul>
      {/if}
      <p class="faint meta">
        Decoration only: none of this changes how Nudge works. Switch it off under Settings → Appearance.
      </p>
    {/if}
  </section>
{/if}

<style>
  .hall {
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    min-width: 0;
  }
  h2 {
    font-size: 15px;
    font-weight: 600;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin-top: var(--s2);
  }
  .hero {
    display: flex;
    gap: var(--s4);
    align-items: center;
    min-width: 0;
  }
  .portrait {
    flex: none;
    padding: var(--s2);
    border-radius: var(--radius-lg);
    background: var(--bg-sunken);
  }
  .stats {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .name {
    font-weight: 600;
    font-size: 15px;
    overflow-wrap: anywhere;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
    max-width: 360px;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .accent-phosphor .fill {
    background: #33ff66;
  }
  .accent-amber .fill {
    background: #ffb000;
  }
  .notice {
    color: var(--text-muted);
    font-style: italic;
  }
  .picker {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  .picker select {
    max-width: 100%;
    min-width: 0;
  }
  .grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: var(--s2);
  }
  .card {
    display: flex;
    gap: var(--s3);
    align-items: center;
    padding: var(--s2);
    border-radius: var(--radius);
    background: var(--bg-sunken);
    min-width: 0;
  }
  .card.dim strong {
    color: var(--text-muted);
  }
  .cap {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
  .log {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  @media (max-width: 899px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
