import type { Category, Confidence, EvalItem, Verdict } from './types.js';

export interface RuleHit {
  verdict: Verdict;
  category: Category;
  confidence: Confidence;
  /** Which rule fired, for the audit trail. */
  rule: string;
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
