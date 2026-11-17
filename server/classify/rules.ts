import type { Category, Confidence, EvalItem, Verdict } from './types.js';

export interface RuleHit {
  verdict: Verdict;
  category: Category;
  confidence: Confidence;
  /** Which rule fired, for the audit trail. */
  rule: string;
  /** The text tries to instruct the model: shown as Suspicious, the suggestion's action withheld. */
  injection?: boolean;
}

/**
 * Phrases that only make sense as an attempt to instruct a model. Conservative on purpose: each needs the instruction
 * word AND its target ("ignore the above warning" or "you are now able to" must not match), and a model call still
 * catches subtler attempts. The flag only labels the item Suspicious; nothing is hidden.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|your\s+|the\s+|my\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules|directions?|context)\b/i,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:your|these|those)\s+(?:instructions?|rules|guidelines)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the|in|my|dan)\b(?!\s+(?:able|ready|free|done|set|good|all|going))/i,
  /\b(?:classify|mark|label|rate|treat|categori[sz]e)\s+(?:this|it|the\s+(?:item|comment|issue|message))\s+as\s+(?:needs[_ ]action|no[_ ]reply|urgent|important|not\s+spam|spam|safe|trusted|high\s+priority)\b/i,
  /<\/?\s*(?:system|assistant|tool|developer|instructions?)\s*>/i,
  /^\s*(?:system|assistant|developer)\s*:\s*\S/im,
  /\[\s*(?:system|assistant|inst)\s*\]|<\|(?:im_start|system|assistant)\|>/i,
  /\b(?:reveal|show|print|repeat|leak)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|instructions)\b/i,
  /\bsystem\s+prompt\b/i,
];

/** Does this text look like an attempt to instruct the model? Exported for tests. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

// Emoji, symbols, punctuation and whitespace only.
const NO_WORDS = /^[\p{Extended_Pictographic}\p{P}\p{S}\p{Z}‍️\d]*$/u;
// A short comment that is only appreciation. Anything with a question mark never matches.
const SHORT_PRAISE =
  /^(?:first|great|good|nice|awesome|amazing|brilliant|excellent|wonderful|love(?:d)? (?:it|this)|thanks?|thank you|cool|wow|legend|lol|haha+|well done|fantastic|superb|perfect|top|bravo)\b[\p{P}\p{S}\p{Z}\w ]{0,30}$/iu;
// Off-platform contact and get-rich patterns. Only a signal: "does this work for crypto code?" is legitimate.
const SPAMMY =
  /(?:t\.me\/|\btelegram\b|\bwhats\s?app\b|wa\.me\/|\bbitcoin\b|\bcrypto(?!graph)\w*|\bforex\b|\binvest(?:ment)? (?:with|via)\b)/i;

/**
 * A long, space-free run of varied symbols, marks and numerals with no real words: random glyph strings. Emoji-heavy
 * strings and ordinary text in any language (mostly letters) are not matched.
 */
function isSymbolSoup(text: string): boolean {
  const chars = [...text];
  if (chars.length < 8 || /\s/u.test(text) || new Set(chars).size < 8) return false;
  const count = (re: RegExp): number => chars.filter((c) => re.test(c)).length;
  const symbolic = count(/[\p{S}\p{M}\p{N}\p{P}]/u);
  const emoji = count(/\p{Extended_Pictographic}/u);
  return symbolic / chars.length >= 0.6 && emoji / chars.length <= 0.5;
}

/**
 * Cheap, auditable rules that run before any model. Deliberately conservative: it returns null unless it is sure of
 * the direction, and it never decides "needs_reply".
 */
export function applyRules(item: EvalItem): RuleHit | null {
  // First, and for every provider: an instruction aimed at the model outranks any other rule.
  if (looksLikeInjection(`${item.title ?? ''}\n${item.text}`)) {
    return { verdict: 'spam', category: 'other', confidence: 'medium', rule: 'injection-phrases', injection: true };
  }
  const gh = item.github;
  if (gh) {
    if (item.author === 'ghost' && item.text.trim().length <= 20) {
      return { verdict: 'spam', category: 'other', confidence: 'medium', rule: 'ghost-empty' };
    }
    if (gh.authorType === 'Bot') {
      return { verdict: 'needs_action', category: 'bot', confidence: 'high', rule: 'github-bot-author' };
    }
    return null;
  }
  const text = item.text.trim();
  if (text.includes('?')) return null;
  if (isSymbolSoup(text)) {
    return { verdict: 'spam', category: 'other', confidence: 'medium', rule: 'symbol-soup' };
  }
  if (text === '' || NO_WORDS.test(text)) {
    return { verdict: 'no_reply_needed', category: 'chat', confidence: 'medium', rule: 'no-words' };
  }
  if (SPAMMY.test(text)) {
    return { verdict: 'spam', category: 'other', confidence: 'low', rule: 'spammy-keywords' };
  }
  return null;
}
