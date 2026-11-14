import type { SuggestionDTO } from '../../../shared/types';

/** The model's reason as a quiet fragment: no trailing full stop, first letter lower-cased ("asks a direct question"). */
export function softReason(reason: string): string {
  const r = reason.trim().replace(/[.\s]+$/, '');
  // Keep acronyms and names ("GitHub", "CI") as written: only an ordinary capitalised word is lower-cased.
  return /^[A-Z][a-z]*(\s|$)/.test(r) ? r.charAt(0).toLowerCase() + r.slice(1) : r;
}

/** Text of the chip on a list row: "reply · asks a direct question", or "suspicious" for a flagged item. */
export function chipText(s: SuggestionDTO): string {
  if (s.suspicious || !s.action) return 'suspicious';
  const reason = softReason(s.reason);
  return reason ? `${s.action} · ${reason}` : s.action;
}

/** The longer sentence for tooltips and the open item. */
export function describe(s: SuggestionDTO): string {
  if (s.suspicious || !s.action)
    return 'Suspicious: this text tried to give the assistant instructions. No suggestion.';
  const reason = softReason(s.reason);
  const conf = s.confidence === 'high' ? '' : ` (${s.confidence} confidence)`;
  return `Suggestion: ${s.action}${reason ? ` · ${reason}` : ''}${conf}`;
}
