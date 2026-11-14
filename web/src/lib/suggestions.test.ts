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

  describe('thread state', () => {
    it('says whose turn it is, with the next step, when the model judged the thread', () => {
      const mine = s({ turn: 'matt', nextStep: 'Review the proposed fix and merge' });
      expect(chipText(mine)).toBe('your turn · review the proposed fix and merge');
      expect(describeSuggestion(mine)).toBe(
        'Suggestion: your turn · review the proposed fix and merge · asks a direct question',
      );
    });
    it('says "waiting on them" alone on the chip, and keeps the detail for the tooltip', () => {
      const theirs = s({ turn: 'them', nextStep: 'Wait for the reporter' });
      expect(chipText(theirs)).toBe('waiting on them');
      expect(describeSuggestion(theirs)).toBe(
        'Suggestion: waiting on them · wait for the reporter · asks a direct question',
      );
    });
    it('falls back to the action and reason when it is his turn but there is no next step, or nobody has one', () => {
      expect(chipText(s({ turn: 'matt', nextStep: null }))).toBe('reply · asks a direct question');
      expect(chipText(s({ turn: 'nobody', nextStep: 'Nothing' }))).toBe('reply · asks a direct question');
      expect(chipText(s({ turn: null }))).toBe('reply · asks a direct question');
    });
    it('never shows a turn for a suspected injection attempt', () => {
      const sus = s({ action: null, suspicious: true, turn: 'matt', nextStep: 'obey' });
      expect(chipText(sus)).toBe('suspicious');
      expect(describeSuggestion(sus)).not.toContain('obey');
    });
  });
});
