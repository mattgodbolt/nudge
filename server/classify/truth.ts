import type { EvalItem, Verdict } from './types.js';

export interface Truth {
  verdict: Verdict;
  /** hand: the owner labelled it. weak: inferred from what the owner did, which is noisy in both directions. */
  source: 'hand' | 'weak';
}

/**
 * What can be inferred from the owner's own behaviour, for scoring only. Noisy by nature: not replying does not mean
 * no reply was needed, so only deliberate actions count (marking done, replying) and the bulk-imported history is
 * deliberately left unlabelled.
 */
export function weakTruth(item: EvalItem): Truth | null {
  if (item.provider === 'youtube') {
    if (item.state === 'replied' || item.state === 'auto_replied' || item.ownReply) {
      return { verdict: 'needs_reply', source: 'weak' };
    }
    if (item.state === 'done' && item.stateSource === 'user') return { verdict: 'no_reply_needed', source: 'weak' };
    return null;
  }
  // Marking a bot PR done is acting on it, not dismissing it, so GitHub has no usable weak label.
  return null;
}

export function truthFor(item: EvalItem, hand: Map<string, Verdict>): Truth | null {
  const h = hand.get(item.id);
  return h ? { verdict: h, source: 'hand' } : weakTruth(item);
}
