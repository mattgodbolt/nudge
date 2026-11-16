<script lang="ts">
  // The sidebar's character chip: level, title, a thin XP bar and today's glyphs. A link to the Hall of Heroes. It takes
  // no key and shows nothing about any one item; it only appears when Adventure mode is on.
  import { tierFor } from '../../../shared/rpg';
  import { rpg } from '../lib/stores/rpg.svelte';
  import { chipLabel, chipTooltip, xpFraction } from '../lib/rpg';
  import RpgArt from './RpgArt.svelte';

  const s = $derived(rpg.sheet);
  // One small sparkle per level-up toast (none under reduced motion: see the CSS).
  let sparkling = $state(false);
  let seen = rpg.sparkle;
  $effect(() => {
    if (rpg.sparkle === seen) return;
    seen = rpg.sparkle;
    sparkling = true;
    const t = setTimeout(() => (sparkling = false), 1600);
    return () => clearTimeout(t);
  });
</script>

{#if rpg.enabled && s}
  <a
    class="rpg-chip accent-{s.accent}"
    href="/stats#hall"
    title={chipTooltip(s)}
    aria-label="{chipLabel(s)}. Open the Hall of Heroes"
    data-testid="rpg-chip"
    onclick={(e) => {
      e.preventDefault();
      rpg.openHall();
    }}
  >
    <span class="who">
      <RpgArt kind="avatar" id={tierFor(s.level)} size={22} />
      {#if sparkling}<span class="sparkle" aria-hidden="true" data-testid="rpg-sparkle"></span>{/if}
    </span>
    <span class="text">
      <span class="line">
        <span class="lv">Lv {s.level}</span>
        <span class="title truncate" data-testid="rpg-chip-title">{s.title}</span>
        <span class="glyphs">
          {#if s.today.cloak}<RpgArt kind="loot" id="cloak" size={13} label="Cloak of Inbox Zero" />{/if}
          {#if s.today.lantern}<RpgArt kind="loot" id="lantern" size={13} label="Necromancer's Lantern" />{/if}
          {#if s.today.flame}<span class="flame" role="img" aria-label="Campfire lit, {s.campfire.current} days"
              ><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
                ><path
                  d="M8 1.5 Q12.5 6 12 10 A4 4 0 0 1 4 10 Q4 7.5 6 6 Q6 8.5 7.5 8.5 Q6.5 5 8 1.5 Z"
                  fill="var(--warn)"
                  stroke="var(--accent)"
                  stroke-width="1"
                /></svg
              ></span
            >{/if}
        </span>
      </span>
      <span class="bar" aria-hidden="true"><span class="fill" style="width: {xpFraction(s) * 100}%"></span></span>
    </span>
  </a>
{/if}

<style>
  .rpg-chip {
    /* The sidebar footer is a flex column that is short on room: the chip keeps its height. */
    flex: none;
    min-height: 34px;
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: 4px var(--s2);
    border-radius: var(--radius);
    color: var(--text-muted);
    text-decoration: none;
    min-width: 0;
  }
  .rpg-chip:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .who {
    position: relative;
    flex: none;
    display: flex;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-size: var(--fs-label);
  }
  .lv {
    flex: none;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .glyphs {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .flame {
    display: flex;
  }
  .bar {
    display: block;
    height: 2px;
    border-radius: 1px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .accent-phosphor .fill {
    background: #33ff66;
    box-shadow: 0 0 3px #33ff66;
  }
  .accent-amber .fill {
    background: #ffb000;
    box-shadow: 0 0 3px #ffb000;
  }
  .sparkle {
    position: absolute;
    inset: -4px;
    pointer-events: none;
    background:
      radial-gradient(circle at 20% 20%, var(--warn) 0 1.5px, transparent 2px),
      radial-gradient(circle at 85% 30%, var(--warn) 0 1.5px, transparent 2px),
      radial-gradient(circle at 50% 95%, var(--warn) 0 1.5px, transparent 2px);
    animation: sparkle 1.5s ease-out forwards;
  }
  @keyframes sparkle {
    0% {
      opacity: 0;
      transform: scale(0.6);
    }
    30% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: scale(1.4);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sparkle {
      display: none;
    }
  }
  @media (max-width: 899px) {
    .rpg-chip {
      height: 48px;
      padding: 0 var(--s3);
    }
    .line {
      font-size: 14px;
    }
  }
</style>
