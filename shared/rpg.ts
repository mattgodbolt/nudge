// Adventure mode (docs/RPG.md): the level curve, the titles and the catalogue of achievements, loot and bosses. Pure
// data and arithmetic, shared by the server (which works out who has earned what) and the web app (which draws it).
// Nothing here may be imported by inbox, keys, snooze, suggestion or push code: see server/rpg-boundary.test.ts.

/** Total XP needed to reach `level`: 100 × (level − 1)². Level 1 needs 0. */
export function xpForLevel(level: number): number {
  const n = Math.max(1, Math.floor(level)) - 1;
  return 100 * n * n;
}

/** The level a total XP buys. Integer arithmetic around the square root, so the thresholds are exact. */
export function levelForXp(xp: number): number {
  const x = Math.max(0, Math.floor(xp));
  let n = Math.floor(Math.sqrt(x / 100));
  while (n > 0 && 100 * n * n > x) n--;
  while (100 * (n + 1) * (n + 1) <= x) n++;
  return n + 1;
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
  | 'ctrl_z_adept';

export interface AchievementDef {
  id: AchievementId;
  name: string;
  description: string;
  /** Shown as "???" in the Hall until earned. */
  hidden: boolean;
  /** How many of something it takes, when it is a count (the Hall shows progress). */
  of?: number;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first_blood', name: 'First Blood', description: 'Your first resolution.', hidden: false },
  { id: 'hello_world', name: 'Hello, World', description: 'Your first reply.', hidden: false },
  { id: 'inbox_zero', name: 'Inbox Zero', description: 'The inbox reached zero.', hidden: false },
  { id: 'zero_hero', name: 'Zero Hero', description: 'Inbox at zero on 7 separate days.', hidden: false, of: 7 },
  { id: 'archaeologist', name: 'Archaeologist', description: 'Dealt with something over a year old.', hidden: false },
  { id: 'welcome_wagon', name: 'Welcome Wagon', description: 'Replied to 10 newcomers.', hidden: false, of: 10 },
  {
    id: 'monk',
    name: 'Patience of the Monk',
    description: 'A wait for activity paid off, and you replied.',
    hidden: false,
  },
  { id: 'auditor', name: 'Auditor', description: 'Cleared 10 "Still waiting" items.', hidden: false, of: 10 },
  { id: 'rubber_duck', name: 'Rubber Duck', description: 'Completed 50 todos.', hidden: false, of: 50 },
  {
    id: 'backlog_breaker',
    name: 'Backlog Breaker',
    description: 'Nothing in the inbox older than 30 days.',
    hidden: false,
  },
  {
    id: 'ancient_evil',
    name: 'Ancient Evil Vanquished',
    description: 'Nothing over a year old left in the inbox.',
    hidden: false,
  },
  { id: 'half_life', name: 'Half-Life', description: 'The inbox halved from its biggest.', hidden: true },
  { id: 'polyglot', name: 'Polyglot', description: 'Replied on YouTube and on GitHub in one day.', hidden: false },
  {
    id: 'long_conversation',
    name: 'Long Conversation',
    description: 'Replied 5 times on one thread.',
    hidden: true,
  },
  { id: 'rest', name: 'Rest Is a Skill', description: 'A whole weekend with no triage at all.', hidden: true },
  { id: 'ctrl_z_adept', name: 'Ctrl+Z Adept', description: 'Undid 10 things.', hidden: true, of: 10 },
];

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
