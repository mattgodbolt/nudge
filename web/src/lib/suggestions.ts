import type { SuggestionDTO, SuggestStatusDTO } from '../../../shared/types';
import type { SuggestionFilter } from '../../../shared/api';
import { formatNumber } from './format';

/** The model's reason as a quiet fragment: no trailing full stop, first letter lower-cased ("asks a direct question"). */
export function softReason(reason: string): string {
  const r = reason.trim().replace(/[.\s]+$/, '');
  // Keep acronyms and names ("GitHub", "CI") as written: only an ordinary capitalised word is lower-cased.
  return /^[A-Z][a-z]*(\s|$)/.test(r) ? r.charAt(0).toLowerCase() + r.slice(1) : r;
}

/**
 * What leads the chip: whose turn it is when the model judged the thread (and it matters), else the plain action.
 * "your turn" needs a next step to say something; "waiting on them" stands alone.
 */
function lead(s: SuggestionDTO): string {
  if (s.turn === 'them') return 'waiting on them';
  if (s.turn === 'matt' && s.nextStep) return 'your turn';
  return s.action ?? '';
}

/** Text of the chip on a list row: "reply · asks a direct question", "your turn · review the fix", "waiting on them". */
export function chipText(s: SuggestionDTO): string {
  if (s.suspicious || !s.action) return 'suspicious';
  if (s.turn === 'them') return lead(s);
  const detail = s.turn === 'matt' && s.nextStep ? softReason(s.nextStep) : softReason(s.reason);
  return detail ? `${lead(s)} · ${detail}` : lead(s);
}

/** The longer sentence for tooltips and the open item. */
export function describe(s: SuggestionDTO): string {
  if (s.suspicious || !s.action)
    return 'Suspicious: this text tried to give the assistant instructions. No suggestion.';
  const parts = [lead(s)];
  if (s.nextStep) parts.push(softReason(s.nextStep));
  const reason = softReason(s.reason);
  if (reason) parts.push(reason);
  const conf = s.confidence === 'high' ? '' : ` (${s.confidence} confidence)`;
  return `Suggestion: ${parts.join(' · ')}${conf}`;
}

/** The inbox's suggestion filter, in the order of the dropdown. */
export const SUGGESTION_FILTER_OPTIONS: readonly { value: '' | SuggestionFilter; label: string }[] = [
  { value: '', label: 'Any suggestion' },
  { value: 'reply', label: 'Reply' },
  { value: 'act', label: 'Act' },
  { value: 'skip', label: 'Skip' },
  { value: 'matt', label: 'Your turn' },
  { value: 'them', label: 'Waiting on them' },
  { value: 'spam', label: 'Spam' },
  { value: 'suspicious', label: 'Suspicious' },
  { value: 'none', label: 'No suggestion yet' },
];

export function isSuggestionFilter(v: unknown): v is SuggestionFilter {
  return SUGGESTION_FILTER_OPTIONS.some((o) => o.value !== '' && o.value === v);
}

const utcTime = (iso: string) => `${iso.slice(11, 16)} UTC`;

/**
 * The quiet progress line ("Suggestions: 412 of 1,870 done, paused until reset"), or null when there is nothing to say:
 * no key, an empty inbox, or everything done and nothing waiting.
 */
export function progressLine(s: SuggestStatusDTO | null): string | null {
  if (!s || !s.enabled || s.total === 0) return null;
  const count = `${formatNumber(s.done)} of ${formatNumber(s.total)} done`;
  if (s.paused) {
    const why = {
      cap: `paused until the daily limit resets${s.paused.until ? ` (${utcTime(s.paused.until)})` : ''}`,
      'rate-limit': `paused until GitHub's rate limit resets${s.paused.until ? ` (${utcTime(s.paused.until)})` : ''}`,
      backoff: 'retrying shortly',
      'key-rejected': 'paused: the assistant key was rejected',
    }[s.paused.reason];
    return `Suggestions: ${count}, ${why}`;
  }
  if (s.done >= s.total) return null;
  return `Suggestions: ${count}${s.working ? ', working' : ''}`;
}
