// Shared by the prompt tests: a sample profile and the words that must never describe the owner.
import type { OwnerProfile } from '../../shared/owner.js';

export const IDENTITY =
  'Priya maintains a JSON parser and a small static-site generator, and writes a blog about both.';
export const SAMPLE_OWNER: OwnerProfile = { name: 'Priya', about: IDENTITY };

/** A gendered pronoun as a whole word. The prompts name the owner, say "the owner", or use "they". */
export const GENDERED = /\b(he|him|his|himself|she|her|hers|herself)\b/i;
