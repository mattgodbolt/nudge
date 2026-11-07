/** A Google OAuth client as downloaded from the Cloud console (or typed in by hand). */
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

export const isValidClientId = (id: string): boolean =>
  id.length > CLIENT_ID_SUFFIX.length && id.endsWith(CLIENT_ID_SUFFIX);

/**
 * Parse the JSON that the console's "Download JSON" gives (`{installed:{...}}`, `{web:{...}}`) or a flat
 * `{client_id, client_secret}` / `{clientId, clientSecret}`. Pure: returns null for anything unusable
 * (bad JSON, missing fields, a client id that is not a Google one).
 */
export function parseGoogleClientJson(text: string): GoogleClient | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const inner = [o.installed, o.web].find((x) => x !== null && typeof x === 'object' && !Array.isArray(x)) ?? o;
  const c = inner as Record<string, unknown>;
  const clientId = c.client_id ?? c.clientId;
  const clientSecret = c.client_secret ?? c.clientSecret;
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null;
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!isValidClientId(id) || secret === '') return null;
  return { clientId: id, clientSecret: secret };
}
