import { describe, expect, it } from 'vitest';
import type { RpgNews, RpgSheet } from '../../../shared/types';
import { statLine } from '../../../shared/rpg';
import {
  REBALANCED_LINE,
  TOAST_PARTS,
  campfireLine,
  campfireSummary,
  chipLabel,
  chipTooltip,
  dayName,
  newsToast,
  tierLine,
  xpFraction,
  xpLine,
} from './rpg';

const none: RpgNews = {
  arrive: null,
  rebalanced: null,
  levelUp: null,
  achievements: [],
  bosses: [],
  loot: [],
  campfire: null,
};
const sheet = (over: Partial<RpgSheet> = {}): RpgSheet => ({
  day: '2026-11-16',
  xp: 1700,
  level: 5,
  levelTitle: 'Hedge Wizard of Triage',
  title: 'Hedge Wizard of Triage',
  levelXp: 1600,
  nextLevelXp: 2500,
  today: { cloak: false, lantern: false, hat: false, flame: false },
  campfire: { current: 0, longest: 0, restUsed: false, goodToRestore: 0, notice: null },
  accent: 'default',
  achievements: [],
  bosses: [],
  loot: [],
  lootLog: [],
  titles: [],
  chosenTitle: null,
  tally: { payouts: 0, replies: 0, dones: 0, dismissals: 0 },
  ...over,
});

describe('chip and XP', () => {
  it('labels the level and title', () => {
    expect(chipLabel({ level: 7, title: 'Ranger of the Backlog' })).toBe('Lv 7 · Ranger of the Backlog');
  });
  it('fills the bar by progress through the level, clamped', () => {
    expect(xpFraction(sheet())).toBeCloseTo(100 / 900);
    expect(xpFraction(sheet({ xp: 0, levelXp: 0, nextLevelXp: 100 }))).toBe(0);
    expect(xpFraction(sheet({ xp: 5000 }))).toBe(1);
    expect(xpFraction(sheet({ levelXp: 100, nextLevelXp: 100 }))).toBe(0);
  });
  it('says how far to the next level, with thousands separators', () => {
    expect(xpLine(sheet())).toBe('1,700 XP · 800 to level 6');
  });
  it('puts the campfire and any missed day in the tooltip', () => {
    const tip = chipTooltip(
      sheet({
        campfire: {
          current: 4,
          longest: 9,
          restUsed: true,
          goodToRestore: 2,
          notice: { kind: 'forgiven', day: '2026-11-10' },
        },
      }),
    );
    expect(tip.split('\n')).toEqual([
      'Lv 5 · Hedge Wizard of Triage',
      '1,700 XP · 800 to level 6',
      'Campfire: 4 good days in a row · Longest: 9 · Rest day used; it comes back after 2 more good days',
      'You missed Tuesday. The campfire flickers. A rest day covered it.',
    ]);
  });
});

describe('achievement tiers', () => {
  it('reads a ladder tier as "II of V", and a one-off or unearned ladder as nothing', () => {
    expect(tierLine({ tier: 2, tiers: 5 })).toBe('II of V');
    expect(tierLine({ tier: 6, tiers: 6 })).toBe('VI of VI');
    expect(tierLine({ tier: 0, tiers: 5 })).toBeNull();
    expect(tierLine({ tier: 1, tiers: 1 })).toBeNull();
  });
});

describe('days and the campfire', () => {
  it('names a day of the last week by weekday, older ones by date', () => {
    expect(dayName('2026-11-16', '2026-11-16')).toBe('Monday');
    expect(dayName('2026-11-10', '2026-11-16')).toBe('Tuesday');
    expect(dayName('2026-11-09', '2026-11-16')).toBe('9 Nov');
  });
  it('is kind about a missed day, and never mentions losing anything', () => {
    const forgiven = campfireLine({ kind: 'forgiven', day: '2026-11-10' }, '2026-11-16');
    const out = campfireLine({ kind: 'out', day: '2026-11-10' }, '2026-11-16');
    expect(forgiven).toBe('You missed Tuesday. The campfire flickers. A rest day covered it.');
    expect(out).toBe('The campfire went out on Tuesday. Light it again with any reply.');
    for (const line of [forgiven, out]) expect(line).not.toMatch(/XP|level|lost|lose|penalt/i);
  });
  it('summarises an unlit campfire with only the longest run', () => {
    expect(campfireSummary(sheet({ campfire: { ...sheet().campfire, longest: 3 } }))).toEqual(['Longest: 3']);
    expect(campfireSummary(sheet())).toEqual([]);
  });
});

describe('the toast for a claim', () => {
  it('says nothing when there is nothing new', () => {
    expect(newsToast(none, '2026-11-16')).toBeNull();
  });
  it('arrives without a ding', () => {
    expect(newsToast({ ...none, arrive: { level: 9, title: 'Cleric of the Clean Shutdown' } }, '2026-11-16')).toEqual({
      message: 'You arrive as a Level 9 Cleric of the Clean Shutdown.',
      ding: false,
    });
  });
  it('says the game was rebalanced once, quietly, with the level as it now is', () => {
    const t = newsToast({ ...none, rebalanced: { level: 3, title: 'Squire of Snooze' } }, '2026-11-16')!;
    expect(t).toEqual({
      message: 'The dungeon grew. Levels were re-forged. You stand at Level 3: Squire of Snooze.',
      ding: false,
    });
    expect(t.message.startsWith(REBALANCED_LINE)).toBe(true);
  });
  it('dings on a level-up, and folds several levels into one line', () => {
    const one = newsToast({ ...none, levelUp: { from: 6, to: 7, title: 'Ranger of the Backlog' } }, '2026-11-16')!;
    expect(one).toEqual({ message: `Ding! Level 7: Ranger of the Backlog. ${statLine(7)}.`, ding: true });
    const many = newsToast({ ...none, levelUp: { from: 4, to: 7, title: 'Ranger of the Backlog' } }, '2026-11-16')!;
    expect(many.message).toMatch(/^Ding! Levels 5 to 7: Ranger of the Backlog\./);
  });
  it('lists bosses, achievements, loot and the campfire, and sends the rest to the Hall', () => {
    const t = newsToast(
      {
        ...none,
        achievements: [
          { id: 'a', name: 'First Blood', tier: 1 },
          { id: 'b', name: 'Rubber Duck II', tier: 2 },
        ],
        bosses: [{ id: 'elder_wyrm', name: 'The Elder Wyrm', line: 'It had hoarded 400 days of guilt.' }],
        loot: [{ id: 'ring', name: 'Ring of Ctrl+Z', line: 'Time is a flat circle.' }],
        campfire: { kind: 'out', day: '2026-11-15' },
      },
      '2026-11-16',
    )!;
    expect(t.ding).toBe(false);
    expect(t.message).toBe(
      'It had hoarded 400 days of guilt. Achievements: First Blood, Rubber Duck II. Time is a flat circle. ' +
        'And 1 more in the Hall of Heroes.',
    );
    expect(TOAST_PARTS).toBe(3);
  });
});
