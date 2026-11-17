import { ownerProfileComplete } from '../shared/owner.js';
import type { StoredSettings } from './contracts.js';

/**
 * The line logged at startup when an Anthropic key is set but Settings > About you is not filled in: every model
 * feature is paused (not guessing who it works for), and the log is where someone running it would look first.
 * Null when there is nothing to say.
 */
export function ownerProfileWarning(s: Pick<StoredSettings, 'llm' | 'owner'>): string | null {
  if (!s.llm.apiKey || ownerProfileComplete(s.owner)) return null;
  return (
    'Warning: an Anthropic key is set but Settings > About you is empty. Suggestions, nudge drafts and the assistant ' +
    'are paused (no model calls are made) until a name and a description are filled in there.'
  );
}
