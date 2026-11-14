import type { Classifier } from '../classify/anthropic.js';
import type { Classification, EvalItem } from '../classify/types.js';

/**
 * Demo/e2e suggestion source: no network and no key, and deterministic for a given item so screenshots and tests
 * are stable. A question gets "reply", praise and banter "skip", GitHub pull requests "act" (low confidence for
 * drafts), and text that tries to instruct the classifier is reported as an injection attempt, as the real model does.
 */
export function demoClassify(item: EvalItem, standingNotes: string[] = []): Classification {
  const c: Classification = { ...demoVerdict(item), turn: null, nextStep: null };
  if (c.injectionAttempt) return c;
  const author = item.author?.toLowerCase();
  if (author && standingNotes.some((n) => n.toLowerCase().includes(author))) {
    return { ...c, confidence: 'high', reason: 'Matches one of your standing notes' };
  }
  // Thread state, as the real model is asked to judge it: his own note about the item first, then why he snoozed it,
  // then who wrote last.
  const note = item.ownerNotes?.[0];
  if (note) return { ...c, turn: 'matt', nextStep: `Act on your note: ${note.slice(0, 40)}` };
  if (item.snoozeNote) return { ...c, turn: 'matt', nextStep: item.snoozeNote };
  const last = item.github?.recent?.at(-1);
  if (last) {
    return last.isMatt
      ? { ...c, turn: 'them', nextStep: `Wait for ${item.github?.recent?.find((m) => !m.isMatt)?.author ?? 'a reply'}` }
      : { ...c, turn: 'matt', nextStep: `Answer ${last.author}` };
  }
  return c;
}

function demoVerdict(item: EvalItem): Omit<Classification, 'turn' | 'nextStep'> {
  const t = `${item.title ?? ''} ${item.text}`;
  if (/ignore (all )?(previous|prior) instructions/i.test(t)) {
    return {
      verdict: 'spam',
      category: 'other',
      confidence: 'high',
      reason: 'Tries to give the classifier instructions',
      injectionAttempt: true,
    };
  }
  if (item.github) {
    return item.github.draft
      ? {
          verdict: 'needs_action',
          category: 'other',
          confidence: 'low',
          reason: 'Draft, may not be ready',
          injectionAttempt: false,
        }
      : {
          verdict: 'needs_action',
          category: 'other',
          confidence: 'medium',
          reason: item.kind === 'pr' ? 'Pull request waiting for a review' : 'Issue that needs a decision',
          injectionAttempt: false,
        };
  }
  if (t.includes('?')) {
    return {
      verdict: 'needs_reply',
      category: 'question',
      confidence: 'high',
      reason: 'Asks a direct question',
      injectionAttempt: false,
    };
  }
  if (/\b(thanks?|thank you|great|brilliant|superb|subscribed|quality)\b/i.test(t)) {
    return {
      verdict: 'no_reply_needed',
      category: 'chat',
      confidence: 'medium',
      reason: 'Praise, nothing to answer',
      injectionAttempt: false,
    };
  }
  return {
    verdict: 'needs_reply',
    category: 'other',
    confidence: 'low',
    reason: 'Might deserve an answer',
    injectionAttempt: false,
  };
}

export function createDemoClassifier(): Classifier {
  return {
    model: 'demo',
    async classify(item, ownerNotes) {
      return {
        result: demoClassify(item, ownerNotes),
        usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      };
    },
  };
}
