<script lang="ts">
  // Adventure mode's little pictures: the character (six tiers), loot, bosses and achievement badges. Original flat
  // drawings on a 32×32 grid, coloured only from theme variables so they work in light and dark. Purely decorative
  // unless given a label. `silhouette` greys a drawing out (not earned yet). A badge on a ladder (`tiers` > 1) is
  // drawn as an upgrade of the same medal: its ring goes bronze, silver, gold, platinum, mithril, adamant, it carries
  // the tier's numeral, and the top tiers get a star-burst behind them.
  import { roman, type AvatarTier } from '../../../shared/rpg';

  type Kind = 'avatar' | 'loot' | 'boss' | 'badge';
  let {
    kind,
    id,
    size = 32,
    label = null,
    silhouette = false,
    tier: badgeTier = 0,
    tiers = 1,
  }: {
    kind: Kind;
    id: string;
    size?: number;
    label?: string | null;
    silhouette?: boolean;
    /** Badges: the tier earned (0 = none: drawn as tier I, greyed) out of `tiers`. */
    tier?: number;
    tiers?: number;
  } = $props();
  const tier = $derived(id as AvatarTier);
  const METALS = ['bronze', 'silver', 'gold', 'platinum', 'mithril', 'adamant'];
  const ladder = $derived(kind === 'badge' && tiers > 1);
  const shownTier = $derived(Math.max(1, Math.min(tiers, badgeTier)));
  const ring = $derived(ladder ? `var(--rpg-${METALS[Math.min(METALS.length, shownTier) - 1]})` : 'var(--rpg-gold)');
  const HYDRA_HEADS = [
    { x: 7, y: 8 },
    { x: 16, y: 6 },
    { x: 25, y: 8 },
  ];
</script>

<svg
  class="art"
  class:sil={silhouette}
  viewBox="0 0 32 32"
  width={size}
  height={size}
  role={label ? 'img' : undefined}
  aria-label={label ?? undefined}
  aria-hidden={label ? undefined : 'true'}
  data-art="{kind}:{id}"
>
  {#if label}<title>{label}</title>{/if}
  <g class="ink" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
    {#if kind === 'avatar'}
      <!-- Behind the body: capes and companions. -->
      {#if tier === 'dictator'}
        <path d="M5.5 31 L9 20.5 H23 L26.5 31 Z" fill="var(--rpg-red)" stroke="var(--rpg-o)" />
      {/if}
      {#if tier === 'wizard'}
        <line x1="26" y1="12" x2="26" y2="30.5" stroke="var(--rpg-brown)" stroke-width="1.8" />
        <circle cx="26" cy="10.5" r="2.4" fill="var(--rpg-gold)" stroke="var(--rpg-o)" />
      {/if}
      <!-- Body -->
      <path
        d="M8 31 C8 23.5 11 20.5 16 20.5 C21 20.5 24 23.5 24 31 Z"
        fill={tier === 'peasant'
          ? 'var(--rpg-brown)'
          : tier === 'apprentice'
            ? 'var(--rpg-cloth)'
            : tier === 'wizard'
              ? 'var(--rpg-violet)'
              : tier === 'paladin'
                ? 'var(--rpg-steel)'
                : tier === 'dragon-tamer'
                  ? 'var(--rpg-green)'
                  : 'var(--rpg-violet)'}
        stroke="var(--rpg-o)"
      />
      {#if tier === 'peasant'}
        <rect x="17.5" y="25" width="3.5" height="3" fill="var(--rpg-gold)" stroke="var(--rpg-o)" stroke-width="1" />
      {:else if tier === 'paladin'}
        <path d="M16 21 V31" stroke="var(--rpg-o)" stroke-width="1" />
      {:else if tier === 'dictator'}
        <path d="M13 21 L16 26 L19 21" fill="none" stroke="var(--rpg-gold)" stroke-width="1.4" />
      {/if}
      <!-- Head -->
      <circle cx="16" cy="13.5" r="5.6" fill="var(--rpg-skin)" stroke="var(--rpg-o)" />
      <circle cx="14" cy="13.6" r="0.85" fill="var(--rpg-o)" stroke="none" />
      <circle cx="18" cy="13.6" r="0.85" fill="var(--rpg-o)" stroke="none" />
      {#if tier === 'wizard'}
        <path d="M11.6 15.4 Q16 26 20.4 15.4 Q16 18.2 11.6 15.4 Z" fill="var(--rpg-bone)" stroke="var(--rpg-o)" />
      {:else}
        <path d="M14.4 16 Q16 17.3 17.6 16" fill="none" stroke="var(--rpg-o)" stroke-width="1.1" />
      {/if}
      <!-- Headgear and props -->
      {#if tier === 'peasant'}
        <path d="M11.2 9.6 Q11.8 4.8 16 4.8 Q20.2 4.8 20.8 9.6 Z" fill="var(--rpg-gold)" stroke="var(--rpg-o)" />
        <ellipse cx="16" cy="9.7" rx="8" ry="1.7" fill="var(--rpg-gold)" stroke="var(--rpg-o)" />
      {:else if tier === 'apprentice'}
        <path d="M10.6 10 L16.6 2.6 L21.4 10 Z" fill="var(--rpg-cloth)" stroke="var(--rpg-o)" />
        <rect x="18.5" y="23" width="6.5" height="5" rx="0.6" fill="var(--rpg-red)" stroke="var(--rpg-o)" />
        <line x1="21.75" y1="23.2" x2="21.75" y2="27.8" stroke="var(--rpg-paper)" stroke-width="1" />
      {:else if tier === 'wizard'}
        <path d="M9 10 L18 0.8 L23 10 Z" fill="var(--rpg-violet)" stroke="var(--rpg-o)" />
        <ellipse cx="16" cy="10" rx="8" ry="1.5" fill="var(--rpg-violet)" stroke="var(--rpg-o)" />
        <path
          d="M17 4.2 l0.55 1.15 1.25 0.18 -0.9 0.88 0.21 1.24 -1.11 -0.58 -1.11 0.58 0.21 -1.24 -0.9 -0.88 1.25 -0.18 z"
          fill="var(--rpg-gold)"
          stroke="none"
        />
      {:else if tier === 'paladin'}
        <path d="M10.2 14 Q9.8 7.4 16 7.4 Q22.2 7.4 21.8 14 Z" fill="var(--rpg-steel)" stroke="var(--rpg-o)" />
        <path d="M16 7.4 Q17 3.6 20.5 3.4 Q18.4 5.2 18.6 7.8" fill="var(--rpg-red)" stroke="var(--rpg-o)" />
        <path d="M19 21.5 H26 V25 Q26 29 22.5 30.5 Q19 29 19 25 Z" fill="var(--rpg-red)" stroke="var(--rpg-o)" />
        <path d="M22.5 22.6 V29 M20.4 25 H24.6" stroke="var(--rpg-gold)" stroke-width="1.4" />
      {:else if tier === 'dragon-tamer'}
        <path
          d="M10.4 12 Q10.4 6.6 16 6.6 Q21.6 6.6 21.6 12 Q16 9.6 10.4 12 Z"
          fill="var(--rpg-brown)"
          stroke="var(--rpg-o)"
        />
        <!-- A small dragon on the shoulder. -->
        <path d="M22 18 L25.5 13.5 L26.5 18 Z" fill="var(--rpg-green)" stroke="var(--rpg-o)" stroke-width="1.1" />
        <ellipse cx="24.5" cy="20.5" rx="3.6" ry="2.5" fill="var(--rpg-green)" stroke="var(--rpg-o)" />
        <circle cx="28" cy="17.8" r="2.2" fill="var(--rpg-green)" stroke="var(--rpg-o)" />
        <circle cx="28.6" cy="17.4" r="0.55" fill="var(--rpg-o)" stroke="none" />
        <path d="M29.6 16.2 L30.8 14.8" stroke="var(--rpg-o)" stroke-width="1" />
      {:else if tier === 'dictator'}
        <path
          d="M10.4 9.6 L10.8 4.4 L13.4 7 L16 3.4 L18.6 7 L21.2 4.4 L21.6 9.6 Z"
          fill="var(--rpg-gold)"
          stroke="var(--rpg-o)"
        />
        <circle cx="16" cy="7.6" r="0.9" fill="var(--rpg-red)" stroke="none" />
        <line x1="25.5" y1="19" x2="25.5" y2="30.5" stroke="var(--rpg-gold)" stroke-width="1.8" />
        <circle cx="25.5" cy="17.6" r="1.9" fill="var(--rpg-red)" stroke="var(--rpg-o)" />
      {/if}
    {:else if kind === 'loot'}
      {#if id === 'cloak'}
        <path d="M10 6 H22 L27 28 Q16 31 5 28 Z" fill="var(--rpg-red)" stroke="var(--rpg-o)" />
        <path d="M16 7 V29" stroke="var(--rpg-o)" stroke-width="1" opacity="0.5" />
        <circle cx="16" cy="7.5" r="2" fill="var(--rpg-gold)" stroke="var(--rpg-o)" />
      {:else if id === 'lantern'}
        <circle cx="16" cy="19" r="9" fill="var(--rpg-gold)" opacity="0.25" stroke="none" />
        <path d="M13 6 Q16 2 19 6" fill="none" stroke="var(--rpg-o)" />
        <rect x="11" y="7" width="10" height="3" rx="1" fill="var(--rpg-steel)" stroke="var(--rpg-o)" />
        <path d="M11.5 10 H20.5 L19.5 25 H12.5 Z" fill="var(--rpg-gold)" stroke="var(--rpg-o)" />
        <path d="M16 14 Q18.4 17 16 21 Q13.6 17 16 14 Z" fill="var(--rpg-red)" stroke="none" />
        <rect x="11" y="25" width="10" height="3" rx="1" fill="var(--rpg-steel)" stroke="var(--rpg-o)" />
      {:else if id === 'hat'}
        <path d="M6 25 L18 3 L26 25 Z" fill="var(--rpg-violet)" stroke="var(--rpg-o)" />
        <ellipse cx="16" cy="25.5" rx="13" ry="3" fill="var(--rpg-violet)" stroke="var(--rpg-o)" />
        <path
          d="M17 11 l1 2.1 2.3 0.33 -1.65 1.6 0.39 2.27 -2.04 -1.07 -2.04 1.07 0.39 -2.27 -1.65 -1.6 2.3 -0.33 z"
          fill="var(--rpg-gold)"
          stroke="none"
        />
      {:else if id === 'quill'}
        <path d="M25 4 Q27 14 14 22 L11 19 Q17 6 25 4 Z" fill="var(--rpg-bone)" stroke="var(--rpg-o)" />
        <path d="M24 6 L13 20" stroke="var(--rpg-o)" stroke-width="1" />
        <path d="M12 20 L7 28 L9.5 23.5" fill="none" stroke="var(--rpg-o)" />
        <circle cx="6.5" cy="28.5" r="1.2" fill="var(--rpg-o)" stroke="none" />
      {:else if id === 'ring'}
        <circle cx="16" cy="19" r="8" fill="none" stroke="var(--rpg-o)" stroke-width="5" />
        <circle cx="16" cy="19" r="8" fill="none" stroke="var(--rpg-gold)" stroke-width="3" />
        <path d="M12.5 9 L16 4.5 L19.5 9 L16 12.5 Z" fill="var(--rpg-red)" stroke="var(--rpg-o)" />
      {:else if id === 'phosphor' || id === 'amber'}
        <rect x="4" y="5" width="24" height="18" rx="2.5" fill="#111114" stroke="var(--rpg-o)" />
        <path
          d="M8 11 L11 14 L8 17 M13 17 H19"
          fill="none"
          stroke={id === 'phosphor' ? '#4ade80' : '#fbbf24'}
          stroke-width="1.8"
        />
        <path d="M12 23 L11 28 H21 L20 23" fill="var(--rpg-steel)" stroke="var(--rpg-o)" />
      {:else if id === 'hourglass'}
        <rect x="8" y="3.5" width="16" height="3" rx="1" fill="var(--rpg-brown)" stroke="var(--rpg-o)" />
        <rect x="8" y="25.5" width="16" height="3" rx="1" fill="var(--rpg-brown)" stroke="var(--rpg-o)" />
        <path
          d="M10.5 6.5 H21.5 Q21.5 13 16 16 Q21.5 19 21.5 25.5 H10.5 Q10.5 19 16 16 Q10.5 13 10.5 6.5 Z"
          fill="var(--rpg-paper)"
          stroke="var(--rpg-o)"
        />
        <path
          d="M12.6 24.6 Q16 19.5 19.4 24.6 Z M13.5 9 H18.5 Q17.5 12.5 16 13.5 Q14.5 12.5 13.5 9 Z"
          fill="var(--rpg-gold)"
          stroke="none"
        />
      {:else if id === 'tooth'}
        <path
          d="M8 6 Q16 2 24 6 Q25 14 20 18 L17.5 29 Q16 30 14.5 29 L12 18 Q7 14 8 6 Z"
          fill="var(--rpg-bone)"
          stroke="var(--rpg-o)"
        />
        <path d="M12 9 Q14 8 15 10" fill="none" stroke="var(--rpg-o)" stroke-width="1" opacity="0.5" />
      {:else if id === 'lute'}
        <path d="M17 13 L26 4" stroke="var(--rpg-brown)" stroke-width="3" />
        <path d="M24.5 2.5 L29 5.5 L27 7.5 Z" fill="var(--rpg-brown)" stroke="var(--rpg-o)" />
        <ellipse
          cx="12.5"
          cy="19.5"
          rx="8"
          ry="9"
          transform="rotate(45 12.5 19.5)"
          fill="var(--rpg-gold)"
          stroke="var(--rpg-o)"
        />
        <circle cx="13" cy="19" r="2.4" fill="var(--rpg-o)" stroke="none" />
        <path d="M9 24.5 L25.5 6" stroke="var(--rpg-o)" stroke-width="0.6" />
      {/if}
    {:else if kind === 'boss'}
      {#if id === 'ancient_one'}
        <path d="M5 31 Q5 6 16 4 Q27 6 27 31 Z" fill="var(--rpg-steel)" stroke="var(--rpg-o)" />
        <ellipse cx="16" cy="15" rx="6.5" ry="7" fill="#1c1917" stroke="var(--rpg-o)" />
        <circle cx="13.6" cy="14" r="1.1" fill="var(--rpg-gold)" stroke="none" />
        <circle cx="18.4" cy="14" r="1.1" fill="var(--rpg-gold)" stroke="none" />
        <path d="M11 18 Q16 32 21 18 Q16 21 11 18 Z" fill="var(--rpg-bone)" stroke="var(--rpg-o)" />
      {:else if id === 'hydra'}
        <path d="M6 31 Q8 21 16 21 Q24 21 26 31 Z" fill="var(--rpg-green)" stroke="var(--rpg-o)" />
        <path d="M11 22 Q6 15 7 9" fill="none" stroke="var(--rpg-o)" stroke-width="4.4" />
        <path d="M11 22 Q6 15 7 9" fill="none" stroke="var(--rpg-green)" stroke-width="2.6" />
        <path d="M21 22 Q26 15 25 9" fill="none" stroke="var(--rpg-o)" stroke-width="4.4" />
        <path d="M21 22 Q26 15 25 9" fill="none" stroke="var(--rpg-green)" stroke-width="2.6" />
        <path d="M16 21 V8" fill="none" stroke="var(--rpg-o)" stroke-width="4.4" />
        <path d="M16 21 V8" fill="none" stroke="var(--rpg-green)" stroke-width="2.6" />
        {#each HYDRA_HEADS as h (h.x)}
          <ellipse cx={h.x} cy={h.y} rx="3.2" ry="2.6" fill="var(--rpg-green)" stroke="var(--rpg-o)" />
          <circle cx={h.x + 1} cy={h.y - 0.6} r="0.6" fill="var(--rpg-red)" stroke="none" />
        {/each}
      {:else if id === 'lich'}
        <circle cx="16" cy="17" r="11" fill="var(--rpg-violet)" opacity="0.3" stroke="none" />
        <path
          d="M9 16 Q9 8 16 8 Q23 8 23 16 Q23 20 20.5 21 V25 H11.5 V21 Q9 20 9 16 Z"
          fill="var(--rpg-bone)"
          stroke="var(--rpg-o)"
        />
        <circle cx="13.3" cy="16" r="2" fill="var(--rpg-o)" stroke="none" />
        <circle cx="18.7" cy="16" r="2" fill="var(--rpg-o)" stroke="none" />
        <circle cx="13.3" cy="16" r="0.7" fill="#4ade80" stroke="none" />
        <circle cx="18.7" cy="16" r="0.7" fill="#4ade80" stroke="none" />
        <path d="M14 22.5 V25 M16 22.5 V25 M18 22.5 V25" stroke="var(--rpg-o)" stroke-width="0.9" />
        <path
          d="M10 9 L10.5 3.5 L13 6.5 L16 2.5 L19 6.5 L21.5 3.5 L22 9 Z"
          fill="var(--rpg-gold)"
          stroke="var(--rpg-o)"
        />
      {:else if id === 'elder_wyrm'}
        <path d="M9 9 L6 2.5 L12.5 7 Z M21 7 L27 2 L24 9 Z" fill="var(--rpg-bone)" stroke="var(--rpg-o)" />
        <path
          d="M5 14 Q6 6 16 6 Q26 6 27 14 L29 22 Q29 27 23 27 L20 30 H12 L9 27 Q3 27 3 22 Z"
          fill="var(--rpg-red)"
          stroke="var(--rpg-o)"
        />
        <path
          d="M9.5 14 L14 15.5 L10 17 Z M22.5 14 L18 15.5 L22 17 Z"
          fill="var(--rpg-gold)"
          stroke="var(--rpg-o)"
          stroke-width="1"
        />
        <circle cx="12.5" cy="24" r="0.9" fill="var(--rpg-o)" stroke="none" />
        <circle cx="19.5" cy="24" r="0.9" fill="var(--rpg-o)" stroke="none" />
        <path
          d="M12 27.5 L13 29.5 L14 27.5 M18 27.5 L19 29.5 L20 27.5"
          fill="var(--rpg-bone)"
          stroke="var(--rpg-o)"
          stroke-width="0.8"
        />
      {/if}
    {:else}
      <!-- An achievement badge: a medal on a ribbon, with a glyph. -->
      {#if ladder && shownTier >= 4}
        <path
          d="M16 -0.5 L18.2 3.6 L22.8 1.3 L22.6 6.3 L27.6 6.1 L25.2 10.6 L29.5 13 L25.2 15.4 L27.6 19.9 L22.6 19.7 L22.8 24.7 L18.2 22.4 L16 26.5 L13.8 22.4 L9.2 24.7 L9.4 19.7 L4.4 19.9 L6.8 15.4 L2.5 13 L6.8 10.6 L4.4 6.1 L9.4 6.3 L9.2 1.3 L13.8 3.6 Z"
          fill={ring}
          stroke="var(--rpg-o)"
          stroke-width="0.9"
          opacity="0.85"
        />
      {/if}
      <path
        d="M10 18 L7 30 L11 28 L13 31 L15 21 Z M22 18 L25 30 L21 28 L19 31 L17 21 Z"
        fill="var(--rpg-red)"
        stroke="var(--rpg-o)"
        stroke-width="1.1"
      />
      <circle
        cx="16"
        cy="13"
        r="11"
        fill={ring}
        stroke="var(--rpg-o)"
        data-ring={ladder ? METALS[shownTier - 1] : 'gold'}
      />
      <circle cx="16" cy="13" r="8.2" fill="var(--rpg-paper)" stroke="var(--rpg-o)" stroke-width="1" />
      <g class="glyph" fill="none" stroke="var(--rpg-o)" stroke-width="1.5">
        {#if id === 'first_blood'}
          <path d="M16 7.5 Q20.5 13 20.5 15 A4.5 4.5 0 0 1 11.5 15 Q11.5 13 16 7.5 Z" fill="var(--rpg-red)" />
        {:else if id === 'hello_world'}
          <path d="M10.5 9 H21.5 V16 H15 L12 19 V16 H10.5 Z" fill="var(--rpg-cloth)" />
        {:else if id === 'inbox_zero'}
          <ellipse cx="16" cy="13" rx="3.4" ry="4.6" stroke-width="2" />
        {:else if id === 'zero_hero'}
          <path
            d="M16 7.2 l1.8 3.7 4 0.6 -2.9 2.8 0.7 4 -3.6 -1.9 -3.6 1.9 0.7 -4 -2.9 -2.8 4 -0.6 z"
            fill="var(--rpg-gold)"
          />
        {:else if id === 'archaeologist'}
          <path d="M11 18 L20 9 M18 7.5 L22.5 12" stroke-width="1.8" />
          <path d="M18 7.5 Q21 7 22.5 12" fill="var(--rpg-steel)" />
        {:else if id === 'welcome_wagon'}
          <circle cx="16" cy="13" r="5" />
          <path d="M16 8 V18 M11 13 H21 M12.5 9.5 L19.5 16.5 M19.5 9.5 L12.5 16.5" stroke-width="1" />
        {:else if id === 'monk'}
          <path d="M20.5 10.5 A5 5 0 1 0 21 14.5" stroke-width="2.2" />
        {:else if id === 'groundhog'}
          <path d="M20.5 10.5 A5 5 0 1 0 21 14.5" stroke-width="1.8" />
          <path d="M21.2 7.4 L20.6 10.8 L17.4 10" stroke-width="1.5" />
        {:else if id === 'veteran'}
          <path d="M11 18 L20.5 8.5 M21 18 L11.5 8.5" stroke-width="1.7" />
          <path d="M12.3 14.3 L14.7 16.7 M19.7 14.3 L17.3 16.7" stroke-width="1.5" />
        {:else if id === 'town_crier'}
          <path d="M12 16.5 Q12 9 16 8.4 Q20 9 20 16.5 Z" fill="var(--rpg-gold)" stroke-width="1.1" />
          <path d="M10.8 16.5 H21.2" stroke-width="1.4" />
          <circle cx="16" cy="18.4" r="1.1" fill="var(--rpg-o)" stroke="none" />
        {:else if id === 'fan_mail'}
          <rect x="10.5" y="9.3" width="11" height="7.6" rx="0.8" fill="var(--rpg-cloth)" stroke-width="1.1" />
          <path d="M10.7 9.6 L16 13.8 L21.3 9.6" stroke-width="1.1" />
        {:else if id === 'reviewer'}
          <circle cx="12.5" cy="9.5" r="1.6" stroke-width="1.2" />
          <circle cx="12.5" cy="17" r="1.6" stroke-width="1.2" />
          <circle cx="19.5" cy="17" r="1.6" stroke-width="1.2" />
          <path
            d="M12.5 11.1 V15.4 M19.5 15.4 V11.8 Q19.5 9.5 17.3 9.5 H15.3 M16.6 8.2 L15.2 9.5 L16.6 10.8"
            stroke-width="1.2"
          />
        {:else if id === 'bug_wrangler'}
          <path
            d="M12.8 12.2 L10.6 11 M12.6 14.6 H10.2 M12.8 16.6 L10.8 18 M19.2 12.2 L21.4 11 M19.4 14.6 H21.8 M19.2 16.6 L21.2 18"
            stroke-width="1"
          />
          <ellipse cx="16" cy="14.4" rx="3.3" ry="4.2" fill="var(--rpg-red)" stroke-width="1.1" />
          <circle cx="16" cy="9.3" r="1.7" fill="var(--rpg-o)" stroke="none" />
          <path d="M16 10.8 V18.4" stroke-width="0.7" />
        {:else if id === 'necromancer' || id === 'necromancy'}
          <path
            d="M11.5 12.8 Q11.5 8 16 8 Q20.5 8 20.5 12.8 Q20.5 15.3 19 15.9 V18.4 H13 V15.9 Q11.5 15.3 11.5 12.8 Z"
            fill="var(--rpg-bone)"
            stroke-width="1.1"
          />
          <circle cx="14.2" cy="12.8" r="1.3" fill="var(--rpg-o)" stroke="none" />
          <circle cx="17.8" cy="12.8" r="1.3" fill="var(--rpg-o)" stroke="none" />
          {#if id === 'necromancy'}
            <circle cx="14.2" cy="12.8" r="0.5" fill="#4ade80" stroke="none" />
            <circle cx="17.8" cy="12.8" r="0.5" fill="#4ade80" stroke="none" />
          {/if}
          <path d="M15 16.6 V18.4 M17 16.6 V18.4" stroke-width="0.7" />
        {:else if id === 'second_wind'}
          <path
            d="M12.5 8 H19.5 Q19.5 11.5 16 13.2 Q19.5 15 19.5 18.5 H12.5 Q12.5 15 16 13.2 Q12.5 11.5 12.5 8 Z"
            fill="var(--rpg-gold)"
            stroke-width="1.1"
          />
          <path d="M11.5 8 H20.5 M11.5 18.5 H20.5" stroke-width="1.5" />
        {:else if id === 'mimic_hunter'}
          <path
            d="M12 8.5 Q16 6.6 20 8.5 Q20.5 12.4 18.2 14 L17 19 Q16 19.6 15 19 L13.8 14 Q11.5 12.4 12 8.5 Z"
            fill="var(--rpg-bone)"
            stroke-width="1.1"
          />
        {:else if id === 'minstrel'}
          <circle cx="13.6" cy="17" r="2" fill="var(--rpg-o)" stroke="none" />
          <path d="M15.4 17 V8.4 L20.4 9.8 V12.2 L15.4 10.8" fill="var(--rpg-o)" stroke-width="1.1" />
        {:else if id === 'ancient_bane'}
          <path d="M10.8 19.5 Q10.8 8 16 7.4 Q21.2 8 21.2 19.5 Z" fill="var(--rpg-steel)" stroke-width="1.1" />
          <ellipse cx="16" cy="13.4" rx="3" ry="3.4" fill="#1c1917" stroke-width="0.9" />
          <circle cx="14.9" cy="13" r="0.7" fill="var(--rpg-gold)" stroke="none" />
          <circle cx="17.1" cy="13" r="0.7" fill="var(--rpg-gold)" stroke="none" />
        {:else if id === 'hydra_hunter'}
          <path d="M13 18.5 Q11 14.5 11.5 10.5 M16 18.5 V9.8 M19 18.5 Q21 14.5 20.5 10.5" stroke-width="1.7" />
          <circle cx="11.5" cy="9.6" r="1.6" fill="var(--rpg-green)" stroke-width="1" />
          <circle cx="16" cy="8.6" r="1.6" fill="var(--rpg-green)" stroke-width="1" />
          <circle cx="20.5" cy="9.6" r="1.6" fill="var(--rpg-green)" stroke-width="1" />
        {:else if id === 'lich_bane'}
          <path
            d="M11 16.5 L11.5 9.5 L13.8 12 L16 8.4 L18.2 12 L20.5 9.5 L21 16.5 Z"
            fill="var(--rpg-gold)"
            stroke-width="1.1"
          />
          <circle cx="16" cy="14" r="0.9" fill="var(--rpg-red)" stroke="none" />
        {:else if id === 'keeper'}
          <path
            d="M16 7.4 Q20.6 11.8 20.1 15.4 A4.1 4.1 0 0 1 11.9 15.4 Q11.9 12.9 13.9 11.4 Q13.9 13.9 15.5 13.9 Q14.5 10.4 16 7.4 Z"
            fill="var(--rpg-gold)"
            stroke="var(--rpg-red)"
            stroke-width="1.1"
          />
        {:else if id === 'steady_hand'}
          <path d="M11.4 13.4 L14.8 16.8 L20.8 9.4" stroke-width="2.2" />
        {:else if id === 'ascendant'}
          <path d="M11.5 13 L16 8.5 L20.5 13 M11.5 17.6 L16 13.1 L20.5 17.6" stroke-width="1.9" />
        {:else if id === 'trophy_case'}
          <path d="M12 8.4 H20 V11 Q20 15 16 15.4 Q12 15 12 11 Z" fill="var(--rpg-gold)" stroke-width="1.1" />
          <path
            d="M12 9.4 Q9.8 9.7 10.5 11.9 Q11 12.9 12.4 12.9 M20 9.4 Q22.2 9.7 21.5 11.9 Q21 12.9 19.6 12.9 M16 15.4 V17.4 M13.4 18.4 H18.6"
            stroke-width="1.1"
          />
        {:else if id === 'spooky'}
          <ellipse cx="16" cy="14.3" rx="5.4" ry="4.3" fill="#ea7a2c" stroke-width="1.1" />
          <path d="M16 10 V18.6 M13.2 10.6 Q12 14.3 13.2 18.1 M18.8 10.6 Q20 14.3 18.8 18.1" stroke-width="0.7" />
          <path d="M16 10 Q16.4 7.6 18.2 7.2" stroke="var(--rpg-green)" stroke-width="1.4" />
        {:else if id === 'the_answer' || id === 'leet' || id === 'off_by_one' || id === 'leap_day'}
          <text
            x="16"
            y={id === 'leet' ? 14.9 : 15.6}
            text-anchor="middle"
            font-size={id === 'leet' ? 5 : 7}
            font-weight="700"
            font-family="ui-monospace, monospace"
            fill="var(--rpg-o)"
            stroke="none"
          >
            {id === 'the_answer' ? '42' : id === 'leet' ? '1337' : id === 'off_by_one' ? '±1' : '29'}
          </text>
        {:else if id === 'auditor'}
          <circle cx="14.8" cy="11.8" r="3.6" />
          <path d="M17.4 14.4 L21 18" stroke-width="2.2" />
        {:else if id === 'rubber_duck' || id === 'quack'}
          <path
            d="M10.5 15 Q10.5 18.5 15 18.5 H19 Q22 18.5 21.5 14.5 L18.5 14 Q19.5 9 16 8.5 Q12.8 8.5 13 12 Q13.4 14 14.8 14.5 Z"
            fill="var(--rpg-gold)"
            stroke-width="1"
          />
          <path d="M12.6 11 L10.4 11.8 L12.8 12.6 Z" fill="var(--rpg-red)" stroke-width="0.6" />
        {:else if id === 'backlog_breaker'}
          <path d="M11 17.5 L16.5 12 M14.5 8 L20.5 14 M13.5 9.5 L19 15" stroke-width="2" />
        {:else if id === 'ancient_evil'}
          <circle cx="16" cy="13" r="2.8" fill="var(--rpg-gold)" />
          <path
            d="M16 6.5 V8.5 M16 17.5 V19.5 M9.5 13 H11.5 M20.5 13 H22.5 M11.4 8.4 L12.8 9.8 M19.2 16.2 L20.6 17.6 M20.6 8.4 L19.2 9.8 M12.8 16.2 L11.4 17.6"
            stroke-width="1.2"
          />
        {:else if id === 'half_life'}
          <circle cx="16" cy="13" r="5" />
          <path d="M16 8 A5 5 0 0 1 16 18 Z" fill="var(--rpg-o)" />
        {:else if id === 'polyglot'}
          <path d="M9.5 8.5 H17 V13.5 H12.5 L10.5 15.5 V13.5 H9.5 Z" fill="var(--rpg-red)" stroke-width="1" />
          <path d="M14.5 11.5 H22.5 V16.5 H21.5 V18.5 L19.5 16.5 H14.5 Z" fill="var(--rpg-cloth)" stroke-width="1" />
        {:else if id === 'long_conversation'}
          <circle cx="12" cy="13" r="1.3" fill="var(--rpg-o)" />
          <circle cx="16" cy="13" r="1.3" fill="var(--rpg-o)" />
          <circle cx="20" cy="13" r="1.3" fill="var(--rpg-o)" />
        {:else if id === 'rest'}
          <path d="M18.5 8 A5.5 5.5 0 1 0 21 16.5 A4.5 4.5 0 0 1 18.5 8 Z" fill="var(--rpg-gold)" stroke-width="1" />
        {:else if id === 'ctrl_z_adept'}
          <path d="M12 11 H18 A3.5 3.5 0 0 1 18 18 H13" stroke-width="1.8" />
          <path d="M14.5 8 L11.5 11 L14.5 14" stroke-width="1.8" />
        {:else}
          <path d="M13.2 10.6 Q13.2 7.8 16 7.8 Q18.8 7.8 18.8 10.4 Q18.8 12 16 13.2 V14.8" stroke-width="1.9" />
          <circle cx="16" cy="17.8" r="1.1" fill="var(--rpg-o)" stroke="none" />
        {/if}
      </g>
      {#if ladder}
        <!-- The tier's numeral on a little plaque over the ribbon. -->
        <rect
          x="10.4"
          y="23.2"
          width="11.2"
          height="7.6"
          rx="1.8"
          fill="var(--rpg-paper)"
          stroke="var(--rpg-o)"
          stroke-width="1"
        />
        <text
          class="numeral"
          x="16"
          y="29.1"
          text-anchor="middle"
          font-size="6"
          font-weight="700"
          fill="var(--rpg-o)"
          stroke="none"
          data-numeral={roman(shownTier)}
        >
          {roman(shownTier)}
        </text>
      {/if}
    {/if}
  </g>
</svg>

<style>
  .art {
    --rpg-o: var(--text);
    --rpg-skin: color-mix(in srgb, #f2c29b 88%, var(--bg));
    --rpg-gold: var(--warn);
    --rpg-cloth: var(--secondary);
    --rpg-red: var(--accent);
    --rpg-green: var(--success);
    --rpg-paper: var(--bg-elev);
    /* Teeth, bones, beards and quills stay ivory in both themes. */
    --rpg-bone: #f7f1e3;
    --rpg-violet: color-mix(in srgb, #7c3aed 78%, var(--text-muted));
    --rpg-steel: color-mix(in srgb, var(--text-muted) 55%, var(--bg-elev));
    --rpg-brown: color-mix(in srgb, #a16207 70%, var(--bg-elev));
    /* Badge rings by tier. Fixed metals: they read as upgrades in both themes, outlined by --rpg-o. */
    --rpg-bronze: #c47f3d;
    --rpg-silver: #b8c2ce;
    --rpg-platinum: #8fd0e2;
    --rpg-mithril: #a78bfa;
    --rpg-adamant: #f0627f;
    flex: none;
    display: block;
    overflow: visible;
  }
  /* Not earned yet: a flat grey silhouette of the same shape. */
  .art.sil {
    --rpg-o: var(--text-faint);
    --rpg-skin: var(--bg-hover);
    --rpg-gold: var(--bg-hover);
    --rpg-cloth: var(--bg-hover);
    --rpg-red: var(--bg-hover);
    --rpg-green: var(--bg-hover);
    --rpg-paper: var(--bg-hover);
    --rpg-bone: var(--bg-hover);
    --rpg-violet: var(--bg-hover);
    --rpg-steel: var(--bg-hover);
    --rpg-brown: var(--bg-hover);
    --rpg-bronze: var(--bg-hover);
    --rpg-silver: var(--bg-hover);
    --rpg-platinum: var(--bg-hover);
    --rpg-mithril: var(--bg-hover);
    --rpg-adamant: var(--bg-hover);
    opacity: 0.8;
  }
  .numeral {
    font-family: system-ui, sans-serif;
  }
  .art.sil :global([fill^='#']),
  .art.sil :global([stroke^='#']) {
    fill: var(--bg-hover);
    stroke: var(--text-faint);
  }
</style>
