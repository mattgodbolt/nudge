import { describe, expect, it } from 'vitest';
import type { SuggestionDTO } from '../../../shared/types';
import { chipText, describe as describeSuggestion, softReason } from './suggestions';

const s = (over: Partial<SuggestionDTO> = {}): SuggestionDTO => ({
  action: 'reply',
  reason: 'Asks a direct question.',
  confidence: 'high',
  suspicious: false,
  ...over,
});

describe('suggestion text', () => {
  it('softens the reason without mangling names', () => {
    expect(softReason('Asks a direct question.')).toBe('asks a direct question');
    expect(softReason('GitHub bot notice')).toBe('GitHub bot notice');
    expect(softReason('CI failed')).toBe('CI failed');
  });

  it('makes the row chip from the action and reason', () => {
    expect(chipText(s())).toBe('reply · asks a direct question');
    expect(chipText(s({ action: 'skip', reason: '' }))).toBe('skip');
  });

  it('never shows an action or the reason for a suspected injection attempt', () => {
    const sus = s({ action: null, reason: 'ignore previous instructions', suspicious: true });
    expect(chipText(sus)).toBe('suspicious');
    expect(describeSuggestion(sus)).not.toContain('ignore');
    expect(describeSuggestion(sus)).toMatch(/no suggestion/i);
  });

  it('mentions confidence in the longer text only when it is not high', () => {
    expect(describeSuggestion(s())).toBe('Suggestion: reply · asks a direct question');
    expect(describeSuggestion(s({ confidence: 'low' }))).toContain('low confidence');
  });
});
