import type { SuggestionDTO } from '../../../shared/types';

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
