/**
 * The owner's profile: who the model is working for. Every prompt that speaks about the owner is built from it
 * (server/classify/anthropic.ts, server/classify/snooze.ts), so nothing about any one person lives in the code. Shared
 * by the server (validation, the refusal when it is missing) and the browser (Settings > About you, the banner).
 */
export interface OwnerProfile {
  /** What the assistant calls the owner in prompts ("Alex"). */
  name: string;
  /** A short factual paragraph: who they are and what they maintain. The classifier's identity sentence. */
  about: string;
}

export const OWNER_NAME_MAX = 60;
export const OWNER_ABOUT_MAX = 1500;

export const EMPTY_OWNER: OwnerProfile = { name: '', about: '' };

/** Both parts are needed: a prompt with no name or no identity sentence would have the model guess who it works for. */
export const ownerProfileComplete = (p: OwnerProfile | null | undefined): p is OwnerProfile =>
  !!p && p.name.trim() !== '' && p.about.trim() !== '';

/** What a model-backed route answers (409) while the profile is incomplete. */
export const OWNER_PROFILE_MISSING = {
  error: 'owner_profile_missing',
  message: 'Set up your profile in Settings > About you first.',
} as const;

// C0 and C1 controls, DEL, and the Unicode line/paragraph separators. Newlines are allowed in `about` only.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Check one field of a profile update. Returns the trimmed value, or an error message. An empty string is allowed: it
 * clears the field. `about` may hold line breaks (it is a paragraph, maybe two); the name may not.
 */
export function checkOwnerField(field: 'name' | 'about', v: unknown): { value: string } | { error: string } {
  if (typeof v !== 'string') return { error: `"owner.${field}" must be a string` };
  const value = v.replace(/\r\n?/g, '\n').trim();
  const max = field === 'name' ? OWNER_NAME_MAX : OWNER_ABOUT_MAX;
  if (value.length > max) return { error: `"owner.${field}" must be at most ${max} characters` };
  if ((field === 'name' ? CONTROL_OR_NEWLINE : CONTROL).test(value)) {
    return { error: `"owner.${field}" must not contain control characters` };
  }
  return { value };
}
