// Adventure mode's words: the chip label, the XP bar, the toast for a claim and the campfire's line. Pure, so they are
// tested on their own (rpg.test.ts). Nothing in the inbox, keys or snooze code may import this (rpg-boundary.test.ts).
import type { RpgAchievementDTO, RpgCampfireNotice, RpgNews, RpgSheet } from '../../../shared/types';
import { roman, statLine } from '../../../shared/rpg';

export const chipLabel = (s: Pick<RpgSheet, 'level' | 'title'>) => `Lv ${s.level} · ${s.title}`;

/** How far through the current level, 0..1. */
export function xpFraction(s: Pick<RpgSheet, 'xp' | 'levelXp' | 'nextLevelXp'>): number {
  const span = s.nextLevelXp - s.levelXp;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (s.xp - s.levelXp) / span));
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function xpLine(s: Pick<RpgSheet, 'xp' | 'level' | 'nextLevelXp'>): string {
  return `${fmt(s.xp)} XP · ${fmt(Math.max(0, s.nextLevelXp - s.xp))} to level ${s.level + 1}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMs = (key: string) => Date.parse(`${key}T00:00:00Z`);

/** "Tuesday" within the last week, else "12 Nov". Both keys are YYYY-MM-DD in the same zone. */
export function dayName(key: string, todayKey: string): string {
  const d = new Date(dayMs(key));
  const ago = Math.round((dayMs(todayKey) - dayMs(key)) / 86_400_000);
  if (ago >= 0 && ago < 7) return WEEKDAYS[d.getUTCDay()]!;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** One kind line about a missed day. Never a word about XP or anything being lost: nothing is. */
export function campfireLine(n: RpgCampfireNotice, todayKey: string): string {
  const when = dayName(n.day, todayKey);
  return n.kind === 'forgiven'
    ? `You missed ${when}. The campfire flickers. A rest day covered it.`
    : `The campfire went out on ${when}. Light it again with any reply.`;
}

/** The campfire for the Hall and the chip tooltip. */
export function campfireSummary(s: Pick<RpgSheet, 'campfire' | 'day'>): string[] {
  const c = s.campfire;
  const out: string[] = [];
  if (c.current > 0) out.push(`Campfire: ${c.current} good day${c.current === 1 ? '' : 's'} in a row`);
  if (c.longest > 0) out.push(`Longest: ${c.longest}`);
  if (c.restUsed)
    out.push(`Rest day used; it comes back after ${c.goodToRestore} more good day${c.goodToRestore === 1 ? '' : 's'}`);
  return out;
}

export function chipTooltip(s: RpgSheet): string {
  const lines = [chipLabel(s), xpLine(s)];
  const fire = campfireSummary(s);
  if (fire.length) lines.push(fire.join(' · '));
  if (s.campfire.notice) lines.push(campfireLine(s.campfire.notice, s.day));
  return lines.join('\n');
}

/** Said once, on the first claim after the game was rebalanced (docs/RPG.md, "Rebalancing"). */
export const REBALANCED_LINE = 'The dungeon grew. Levels were re-forged.';

/** A ladder's tier as the Hall shows it: "II of V". A one-off has none. */
export function tierLine(a: Pick<RpgAchievementDTO, 'tier' | 'tiers'>): string | null {
  if (a.tiers <= 1 || a.tier <= 0) return null;
  return `${roman(a.tier)} of ${roman(a.tiers)}`;
}

/** At most this many things in one toast; the rest are in the Hall. */
export const TOAST_PARTS = 3;

/**
 * One toast for everything a claim hands out, or null when there is nothing. `ding` is true only for a level-up (the
 * only thing that may make a sound); the arrival line never dings.
 */
export function newsToast(news: RpgNews, todayKey: string): { message: string; ding: boolean } | null {
  if (news.arrive) {
    const { level, title } = news.arrive;
    return { message: `You arrive as a Level ${level} ${title}.`, ding: false };
  }
  if (news.rebalanced) {
    const { level, title } = news.rebalanced;
    return { message: `${REBALANCED_LINE} You stand at Level ${level}: ${title}.`, ding: false };
  }
  const parts: string[] = [];
  const up = news.levelUp;
  if (up) {
    const lv = up.to - up.from > 1 ? `Levels ${up.from + 1} to ${up.to}` : `Level ${up.to}`;
    parts.push(`Ding! ${lv}: ${up.title}. ${statLine(up.to)}.`);
  }
  for (const b of news.bosses) parts.push(b.line);
  if (news.achievements.length === 1) parts.push(`Achievement: ${news.achievements[0]!.name}.`);
  else if (news.achievements.length > 1)
    parts.push(`Achievements: ${news.achievements.map((a) => a.name).join(', ')}.`);
  for (const l of news.loot) parts.push(l.line);
  if (news.campfire) parts.push(campfireLine(news.campfire, todayKey));
  if (parts.length === 0) return null;
  const shown = parts.slice(0, TOAST_PARTS);
  const more = parts.length - shown.length;
  if (more > 0) shown.push(`And ${more} more in the Hall of Heroes.`);
  return { message: shown.join(' '), ding: !!up };
}

/** The browser's IANA zone, or UTC when it will not say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
