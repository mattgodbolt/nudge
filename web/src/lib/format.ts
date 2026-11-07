const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact relative time: "now", "5m", "3h", "2d", "4w", "Mar 3", "Mar 3, 2023". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = now - t;
  if (d < 45_000) return 'now';
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))}m`;
  if (d < DAY) return `${Math.round(d / HOUR)}h`;
  if (d < 7 * DAY) return `${Math.round(d / DAY)}d`;
  if (d < 30 * DAY) return `${Math.round(d / (7 * DAY))}w`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  const r = relativeTime(iso, now);
  if (!r) return 'never';
  return r === 'now' ? 'just now' : /\d[mhdw]$/.test(r) ? `${r} ago` : r;
}

export function fullDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const d = Date.parse(iso) - now;
  if (d <= 0) return 'now';
  if (d < HOUR) return `in ${Math.ceil(d / MIN)}m`;
  if (d < DAY) return `in ${Math.round(d / HOUR)}h`;
  return `in ${Math.round(d / DAY)}d`;
}

export function pluralize(n: number, word: string): string {
  return `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
}
