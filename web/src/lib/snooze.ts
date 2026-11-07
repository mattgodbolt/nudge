/**
 * Snooze time maths. Everything works in the browser's local timezone and takes `now` as a parameter so it is
 * testable. Dates are always built with the local-time constructor (never "+24h") so DST changes can't shift
 * a "08:00" preset to 07:00 or 09:00.
 */

export type SnoozePresetId = 'later' | 'tomorrow' | 'weekend' | 'nextweek';

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  at: Date;
}

const MORNING_HOUR = 8;
const LATER_HOURS = 3;

/** Local 08:00 on the day `days` after `from`'s date. */
function morning(from: Date, days: number): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, MORNING_HOUR, 0, 0, 0);
}

export function snoozePresets(now: Date): SnoozePreset[] {
  const dow = now.getDay(); // 0 = Sunday
  // Saturday 08:00: the coming Saturday, or the one after when it is already the weekend.
  const toSaturday = dow === 6 || dow === 0 ? (6 - dow + 7) % 7 || 7 : 6 - dow;
  // Monday 08:00 strictly after today.
  const toMonday = (8 - dow) % 7 || 7;
  return [
    { id: 'later', label: 'Later today', at: new Date(now.getTime() + LATER_HOURS * 3_600_000) },
    { id: 'tomorrow', label: 'Tomorrow morning', at: morning(now, 1) },
    { id: 'weekend', label: 'This weekend', at: morning(now, toSaturday) },
    { id: 'nextweek', label: 'Next week', at: morning(now, toMonday) },
  ];
}

/** Default for the custom picker: tomorrow morning. */
export function defaultCustomTime(now: Date): Date {
  return morning(now, 1);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DDTHH:mm` in local time: the value format of <input type="datetime-local">. */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse a datetime-local value as local time; null when empty or invalid. */
export function fromLocalInputValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Tue 8:00 AM" within the next week, "Nov 20, 8:00 AM" beyond (plus the year when it differs). */
export function formatSnoozeTime(when: Date | string, now: Date, locale?: string): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = (d.getTime() - startOfToday) / 86_400_000;
  if (days >= 0 && days < 7) return `${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  const date = d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/** Whether a wake time is recent enough to flag the item as "back from snooze". */
export function recentlyWoken(wokeAt: string | null, now: number, windowMs = 24 * 3_600_000): boolean {
  if (!wokeAt) return false;
  const t = Date.parse(wokeAt);
  return !Number.isNaN(t) && now - t >= 0 && now - t < windowMs;
}
