// Adventure mode (docs/RPG.md): the level curve, the titles and the catalogue of achievements, loot and bosses. Pure
// data and arithmetic, shared by the server (which works out who has earned what) and the web app (which draws it).
// Nothing here may be imported by inbox, keys, snooze, suggestion or push code: see server/rpg-boundary.test.ts.

/**
 * The level curve (docs/RPG.md §3): total XP to reach `level` is 300 × (level − 1)^1.6, rounded to the nearest 10.
 * Level 2 needs 300, level 10 needs 10,090 and level 20 needs 33,350: at a steady few dozen XP a day that is level 10
 * after a few months and level 20 after well over a year. Level 1 needs 0.
 */
export const LEVEL_CURVE = { base: 300, power: 1.6, round: 10 } as const;
export function xpForLevel(level: number): number {
  const n = Math.max(1, Math.floor(level)) - 1;
  if (n === 0) return 0;
  const { base, power, round } = LEVEL_CURVE;
  return round * Math.round((base / round) * n ** power);
}

/** The level a total XP buys: an estimate from the inverse, then stepped so it agrees exactly with xpForLevel. */
export function levelForXp(xp: number): number {
  const x = Math.max(0, Math.floor(xp));
  let l = Math.max(1, Math.floor((x / LEVEL_CURVE.base) ** (1 / LEVEL_CURVE.power)) + 1);
  while (l > 1 && xpForLevel(l) > x) l--;
  while (xpForLevel(l + 1) <= x) l++;
  return l;
}

export const TITLES = [
  'Inbox Peasant',
  'Apprentice of the Unread',
  'Squire of Snooze',
  'Keeper of the Queue',
  'Hedge Wizard of Triage',
  'Journeyman Janitor of Threads',
  'Ranger of the Backlog',
  'Knight of the Round-Robin',
  'Cleric of the Clean Shutdown',
  'Paladin of the Pull Request',
  'Warlock of the Cron Table',
  'Bard of the Reply Box',
  'Sorcerer of the Assembly Pane',
  'Lich-Slayer of Stale Issues',
  'Druid of the Dependency Tree',
  'Grand Inquisitor of Flaky Tests',
  'Dragon-Tamer of the Monorepo',
  'High Priest of /dev/null',
  'Elder of the Elder Issues',
  'Benevolent Dictator of the Inbox (For Life)',
] as const;

const AGES = ['Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

/** The title for a level. Past 20 the titles come round again, "of the Second Age" and so on. */
export function titleFor(level: number): string {
  const l = Math.max(1, Math.floor(level));
  const base = TITLES[(l - 1) % TITLES.length]!;
  const age = Math.floor((l - 1) / TITLES.length); // 0 = the first age, which goes unsaid
  if (age === 0) return base;
  const name = AGES[age - 1];
  return `${base} of the ${name ?? `${age + 1}th`} Age`;
}

/** Which of the six character drawings a level gets. */
export const AVATAR_TIERS = ['peasant', 'apprentice', 'wizard', 'paladin', 'dragon-tamer', 'dictator'] as const;
export type AvatarTier = (typeof AVATAR_TIERS)[number];
export function tierFor(level: number): AvatarTier {
  if (level >= 20) return 'dictator';
  if (level >= 15) return 'dragon-tamer';
  if (level >= 10) return 'paladin';
  if (level >= 6) return 'wizard';
  if (level >= 3) return 'apprentice';
  return 'peasant';
}

/** Silly stat lines for the level-up toast, picked by level so the same level always says the same thing. */
export const STAT_LINES = [
  '+1 Wisdom (does nothing)',
  '+1 Charisma (unverified)',
  '+2 Patience (non-refundable)',
  '+1 Luck (purely decorative)',
  '+1 Stamina (for reading long threads)',
  '+3 Lore of Obscure Flags',
  '+1 Diplomacy (with bots)',
  '+1 Perception (of typos)',
];
export const statLine = (level: number) => STAT_LINES[Math.abs(Math.floor(level)) % STAT_LINES.length]!;

export type AchievementId =
  | 'first_blood'
  | 'hello_world'
  | 'inbox_zero'
  | 'zero_hero'
  | 'archaeologist'
  | 'welcome_wagon'
  | 'monk'
  | 'auditor'
  | 'rubber_duck'
  | 'backlog_breaker'
  | 'ancient_evil'
  | 'half_life'
  | 'polyglot'
  | 'long_conversation'
  | 'rest'
  | 'ctrl_z_adept'
  | 'veteran'
  | 'town_crier'
  | 'fan_mail'
  | 'reviewer'
  | 'bug_wrangler'
  | 'necromancer'
  | 'second_wind'
  | 'mimic_hunter'
  | 'minstrel'
  | 'ancient_bane'
  | 'hydra_hunter'
  | 'lich_bane'
  | 'keeper'
  | 'steady_hand'
  | 'ascendant'
  | 'trophy_case'
  | 'the_answer'
  | 'leet'
  | 'off_by_one'
  | 'groundhog'
  | 'necromancy'
  | 'spooky'
  | 'leap_day'
  | 'quack';

export interface AchievementDef {
  id: AchievementId;
  name: string;
  /** What a tier takes. `{n}` is the tier's threshold and `{s}` an "s" unless it is 1. */
  description: string;
  /** Shown as "???" in the Hall until its first tier is earned. */
  hidden: boolean;
  /**
   * The thresholds of a ladder, ascending: tier k is earned when the count reaches tiers[k − 1]. A one-off has [1].
   * Higher tiers are drawn as upgrades of the same badge (bronze, silver, gold, platinum, mithril, adamant).
   */
  tiers: readonly number[];
}

const ONCE = [1] as const;
/**
 * The catalogue (docs/RPG.md §5). Counts only things done with care: never snoozes, dismissals, speed, per-day counts
 * or unbroken streaks. Bulk actions count only towards Rubber Duck (as before).
 */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first_blood', name: 'First Blood', description: 'Your first resolution.', hidden: false, tiers: ONCE },
  { id: 'hello_world', name: 'Hello, World', description: 'Your first reply.', hidden: false, tiers: ONCE },
  { id: 'inbox_zero', name: 'Inbox Zero', description: 'The inbox reached zero.', hidden: false, tiers: ONCE },
  {
    id: 'veteran',
    name: 'Veteran of the Queue',
    description: 'Dealt with {n} item{s}, done or replied.',
    hidden: false,
    tiers: [100, 500, 1500, 4000, 10000, 25000],
  },
  {
    id: 'town_crier',
    name: 'Town Crier',
    description: 'Replied {n} time{s}.',
    hidden: false,
    tiers: [25, 100, 300, 1000, 3000],
  },
  {
    id: 'rubber_duck',
    name: 'Rubber Duck',
    description: 'Completed {n} todo{s}.',
    hidden: false,
    tiers: [10, 50, 200, 500, 1000],
  },
  {
    id: 'zero_hero',
    name: 'Zero Hero',
    description: 'Inbox at zero on {n} separate day{s}.',
    hidden: false,
    tiers: [7, 30, 100, 250, 500],
  },
  {
    id: 'steady_hand',
    name: 'Steady Hand',
    description: '{n} good campfire day{s} in all, in a row or not.',
    hidden: false,
    tiers: [10, 50, 150, 365, 730],
  },
  {
    id: 'keeper',
    name: 'Keeper of the Flame',
    description: 'A campfire run of {n} good days.',
    hidden: false,
    tiers: [7, 30, 100],
  },
  {
    id: 'ascendant',
    name: 'Ascendant',
    description: 'Reached level {n}.',
    hidden: false,
    tiers: [5, 10, 15, 20, 30, 40],
  },
  {
    id: 'fan_mail',
    name: 'Fan Mail',
    description: 'Replied to {n} YouTube comment{s}.',
    hidden: false,
    tiers: [10, 50, 200, 500],
  },
  {
    id: 'reviewer',
    name: 'Reviewer of Pulls',
    description: 'Dealt with {n} pull request{s}.',
    hidden: false,
    tiers: [10, 50, 200, 500, 1000],
  },
  {
    id: 'bug_wrangler',
    name: 'Bug Wrangler',
    description: 'Dealt with {n} GitHub issue{s}.',
    hidden: false,
    tiers: [10, 50, 200, 500, 1000],
  },
  {
    id: 'welcome_wagon',
    name: 'Welcome Wagon',
    description: 'Replied to {n} newcomer{s}.',
    hidden: false,
    tiers: [5, 25, 100, 250, 500],
  },
  {
    id: 'polyglot',
    name: 'Polyglot',
    description: 'Replied on YouTube and on GitHub in one day, on {n} day{s}.',
    hidden: false,
    tiers: [1, 10, 50, 150, 365],
  },
  {
    id: 'monk',
    name: 'Patience of the Monk',
    description: 'A wait for activity paid off and you replied, {n} time{s}.',
    hidden: false,
    tiers: [1, 10, 50, 150],
  },
  {
    id: 'auditor',
    name: 'Auditor',
    description: 'Cleared {n} "Still waiting" item{s}.',
    hidden: false,
    tiers: [10, 50, 150, 400, 1000],
  },
  {
    id: 'second_wind',
    name: 'Second Wind',
    description: 'Finished {n} thing{s} snoozed three times or more.',
    hidden: false,
    tiers: [1, 10, 50, 150],
  },
  {
    id: 'mimic_hunter',
    name: 'Mimic Hunter',
    description: 'Waited for a merge, saw it merge and marked it done, {n} time{s}.',
    hidden: false,
    tiers: [1, 5, 25],
  },
  {
    id: 'minstrel',
    name: 'Minstrel',
    description: 'Answered {n} YouTube comment{s} 30 days old or more.',
    hidden: false,
    tiers: [1, 10, 50],
  },
  {
    id: 'necromancer',
    name: 'Necromancer',
    description: 'Laid {n} thing{s} of 90 days or more to rest.',
    hidden: false,
    tiers: [5, 25, 100, 300],
  },
  {
    id: 'archaeologist',
    name: 'Archaeologist',
    description: 'Dealt with {n} thing{s} over a year old.',
    hidden: false,
    tiers: [1, 10, 50, 150, 500],
  },
  {
    id: 'backlog_breaker',
    name: 'Backlog Breaker',
    description: 'Nothing in the inbox older than 30 days.',
    hidden: false,
    tiers: ONCE,
  },
  {
    id: 'ancient_evil',
    name: 'Ancient Evil Vanquished',
    description: 'Nothing over a year old left in the inbox.',
    hidden: false,
    tiers: ONCE,
  },
  {
    id: 'ancient_bane',
    name: 'Bane of the Ancient One',
    description: 'Felled the Ancient One {n} time{s}.',
    hidden: false,
    tiers: [1, 10, 50, 150],
  },
  {
    id: 'hydra_hunter',
    name: 'Hydra Hunter',
    description: 'Felled the Hydra {n} time{s}.',
    hidden: false,
    tiers: [1, 5, 20, 60],
  },
  {
    id: 'lich_bane',
    name: 'Lich-Bane',
    description: 'Felled the Lich {n} time{s}.',
    hidden: false,
    tiers: [1, 5, 20, 60],
  },
  {
    id: 'trophy_case',
    name: 'Trophy Case',
    description: 'Earned {n} achievement tiers.',
    hidden: false,
    tiers: [10, 25, 50, 80, 110],
  },
  {
    id: 'half_life',
    name: 'Half-Life',
    description: 'The inbox halved from its biggest.',
    hidden: true,
    tiers: ONCE,
  },
  {
    id: 'long_conversation',
    name: 'Long Conversation',
    description: 'Replied {n} times on one thread.',
    hidden: true,
    tiers: [5, 10, 20, 40],
  },
  {
    id: 'rest',
    name: 'Rest Is a Skill',
    description: '{n} whole weekend{s} with no triage at all.',
    hidden: true,
    tiers: [1, 5, 20],
  },
  {
    id: 'ctrl_z_adept',
    name: 'Ctrl+Z Adept',
    description: 'Undid {n} thing{s}.',
    hidden: true,
    tiers: [10, 50, 200, 500],
  },
  {
    id: 'the_answer',
    name: 'The Answer',
    description: 'Your 42nd reply. Now, what was the question?',
    hidden: true,
    tiers: ONCE,
  },
  { id: 'leet', name: 'L33t', description: 'Reached 1,337 XP. Very elite.', hidden: true, tiers: ONCE },
  {
    id: 'off_by_one',
    name: 'Off-by-One',
    description: 'Undid something, then did it after all.',
    hidden: true,
    tiers: ONCE,
  },
  {
    id: 'groundhog',
    name: 'Groundhog Day',
    description: 'Marked the same thing done three times. It keeps coming back.',
    hidden: true,
    tiers: ONCE,
  },
  {
    id: 'necromancy',
    name: 'Forbidden Necromancy',
    description: 'Dealt with something over three years old.',
    hidden: true,
    tiers: ONCE,
  },
  {
    id: 'spooky',
    name: 'Spooky Season',
    description: 'Laid something to rest on Halloween.',
    hidden: true,
    tiers: ONCE,
  },
  {
    id: 'leap_day',
    name: 'Leap of Faith',
    description: 'Dealt with something on 29 February.',
    hidden: true,
    tiers: ONCE,
  },
  { id: 'quack', name: 'Quack', description: 'Completed a todo with "duck" in its title.', hidden: true, tiers: ONCE },
];

/** Total tiers on offer across the catalogue (the Hall's "N of M"). */
export const ACHIEVEMENT_STEPS = ACHIEVEMENTS.reduce((n, a) => n + a.tiers.length, 0);

/** A tier's description: `{n}` becomes the threshold, `{s}` an "s" unless it is 1. */
export function describeTier(def: Pick<AchievementDef, 'description' | 'tiers'>, tier: number): string {
  const n = def.tiers[Math.min(def.tiers.length, Math.max(1, tier)) - 1] ?? 1;
  return def.description.replace('{n}', n.toLocaleString('en-US')).replace('{s}', n === 1 ? '' : 's');
}

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];
/** 1 → "I", 4 → "IV". Zero or less is "". */
export function roman(n: number): string {
  let x = Math.floor(n);
  let out = '';
  for (const [v, r] of ROMAN) {
    while (x >= v) {
      out += r;
      x -= v;
    }
  }
  return out;
}

/** The key `seen` stores for an achievement tier: the bare id for tier I (as before ladders), "id:k" above it. */
export const tierKey = (id: string, tier: number) => (tier <= 1 ? id : `${id}:${tier}`);

/**
 * Bumped when the game is rebalanced (the curve or the catalogue changes so that old announcements no longer line up).
 * A stored `seen` from an older version gets one quiet "The dungeon grew" line instead of a replay (server/db/rpg.ts).
 */
export const RPG_SEEN_VERSION = 2;

export type BossId = 'ancient_one' | 'hydra' | 'lich' | 'elder_wyrm';
export interface BossDef {
  id: BossId;
  name: string;
  /** Who it is, for the Hall. */
  who: string;
  /** The toast line when it first falls. */
  line: string;
}
export const BOSSES: readonly BossDef[] = [
  {
    id: 'ancient_one',
    name: 'The Ancient One',
    who: 'The oldest item in an inbox of five or more, dealt with.',
    line: 'The Ancient One falls. The backlog trembles.',
  },
  {
    id: 'hydra',
    name: 'The Hydra',
    who: 'A GitHub thread with 20 or more comments.',
    line: 'Cut off one head, two more comments grow. Not this time.',
  },
  {
    id: 'lich',
    name: 'The Lich',
    who: 'Came back with no activity twice, then was resolved.',
    line: 'Its phylactery was a stale branch.',
  },
  {
    id: 'elder_wyrm',
    name: 'The Elder Wyrm',
    who: 'Anything more than a year old.',
    line: 'It had hoarded 400 days of guilt.',
  },
];

export type LootId =
  'cloak' | 'lantern' | 'hat' | 'quill' | 'ring' | 'phosphor' | 'amber' | 'hourglass' | 'tooth' | 'lute';
export interface LootDef {
  id: LootId;
  name: string;
  description: string;
  /** A toast line, for the ones that announce themselves. */
  line?: string;
}
export const LOOT: readonly LootDef[] = [
  { id: 'cloak', name: 'Cloak of Inbox Zero', description: 'Inbox reached zero. Worn for the rest of the day.' },
  {
    id: 'lantern',
    name: "Necromancer's Lantern",
    description: 'Dealt with something 90 days old or more. Lit for the rest of the day.',
    line: 'The dead issue rests.',
  },
  { id: 'hat', name: 'Wizard Hat', description: 'Levelled up. Sits on the Nudge logo until midnight.' },
  { id: 'quill', name: 'Quill of Welcome', description: 'Replied to a newcomer.' },
  {
    id: 'ring',
    name: 'Ring of Ctrl+Z',
    description: 'Undid something. Undo is good.',
    line: 'Time is a flat circle.',
  },
  { id: 'phosphor', name: 'Phosphor Accent', description: 'Level 10: the XP bar glows green-screen.' },
  { id: 'amber', name: 'Amber Accent', description: 'Level 15: the XP bar turns amber terminal.' },
  {
    id: 'hourglass',
    name: "Procrastinator's Redemption",
    description: 'Finished something snoozed three times or more.',
  },
  {
    id: 'tooth',
    name: "Mimic's Tooth",
    description: 'Waited for a merge, it merged, you marked it done.',
    line: 'It was a PR all along.',
  },
  {
    id: 'lute',
    name: "Bard's Lute",
    description: 'Replied to a YouTube comment 30 days old or more.',
    line: 'A long-awaited ballad.',
  },
];

/** The loot log: worthless things found on every 20th payout, chosen by a hash of the item id. */
export const LOOT_LOG_ITEMS = [
  'a semicolon (lowercase)',
  'one unused #include',
  'a deprecated cursor',
  'half a merge conflict',
  'a TODO from 2014',
  'a very small regex',
  'an off-by-one (spare)',
  'the missing closing brace',
  'a lint warning, slightly used',
  'a single trailing space',
  'an expired API key (fake)',
  'a rubber duck feather',
] as const;
export const LOOT_LOG_EVERY = 20;

/** A small stable string hash (FNV-1a), so the loot log never depends on chance. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export const lootLogItem = (itemId: string) => LOOT_LOG_ITEMS[hashString(itemId) % LOOT_LOG_ITEMS.length]!;
