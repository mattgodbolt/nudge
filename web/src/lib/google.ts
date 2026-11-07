import type { GoogleAccountDTO, GoogleAuthDTO } from '../../../shared/types';

export interface GoogleToast {
  message: string;
  kind: 'success' | 'error';
}

/** Outcome of the OAuth round trip, from the `?google=<code>` the callback redirects back with. */
export function googleToast(code: string): GoogleToast {
  switch (code) {
    case 'connected':
      return { message: 'Google account connected. Replies will now post from Youtubey.', kind: 'success' };
    case 'denied':
      return { message: 'Google sign-in was cancelled.', kind: 'error' };
    case 'scope_missing':
      return {
        message:
          'Google did not grant permission to manage your YouTube account. Tick every box on the consent screen.',
        kind: 'error',
      };
    case 'no_channel':
      return { message: 'That Google account has no YouTube channel.', kind: 'error' };
    case 'bad_state':
      return { message: 'The sign-in link expired or was already used. Try connecting again.', kind: 'error' };
    case 'token_exchange_failed':
      return { message: 'Google rejected the sign-in. Check the client ID and secret, then try again.', kind: 'error' };
    case 'no_client':
      return { message: 'No Google client is configured yet.', kind: 'error' };
    default:
      return { message: `Google sign-in failed (${code}).`, kind: 'error' };
  }
}

export const clientSourceLabel = {
  env: 'environment variables',
  settings: 'Settings (stored in the local database)',
  file: 'a client_secret JSON file',
} as const;

export type GoogleState = 'no-client' | 'no-account' | 'connected';

export function googleState(g: GoogleAuthDTO): GoogleState {
  if (!g.clientConfigured) return 'no-client';
  return g.accounts.length === 0 ? 'no-account' : 'connected';
}

export function anyNeedsReauth(accounts: GoogleAccountDTO[]): boolean {
  return accounts.some((a) => a.needsReauth);
}

export function connectedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Connected';
  return `Connected ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}
