import type { Classifier } from '../classify/anthropic.js';
import type { Classification, EvalItem } from '../classify/types.js';

/**
 * Demo/e2e suggestion source: no network and no key, and deterministic for a given item so screenshots and tests
 * are stable. A question gets "reply", praise and banter "skip", GitHub pull requests "act" (low confidence for
 * drafts), and text that tries to instruct the classifier is reported as an injection attempt, as the real model does.
 */
export function demoClassify(item: EvalItem): Classification {
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
    async classify(item) {
      return {
        result: demoClassify(item),
        usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      };
    },
  };
}
