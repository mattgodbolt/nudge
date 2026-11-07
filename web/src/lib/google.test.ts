import { describe, expect, it } from 'vitest';
import type { GoogleAuthDTO } from '../../../shared/types';
import { anyNeedsReauth, connectedLabel, googleState, googleToast } from './google';

const auth = (over: Partial<GoogleAuthDTO>): GoogleAuthDTO => ({
  clientConfigured: true,
  clientSource: 'settings',
  redirectUri: 'http://127.0.0.1:4517/api/auth/callback',
  accounts: [],
  ...over,
});
const acct = (needsReauth: boolean) => ({
  channelId: 'UC1',
  title: 'T',
  thumbnailUrl: null,
  connectedAt: '2026-01-02T00:00:00Z',
  needsReauth,
  lastError: null,
  isDefault: true,
});

describe('google helpers', () => {
  it('maps every callback code to a toast', () => {
    expect(googleToast('connected').kind).toBe('success');
    for (const c of [
      'denied',
      'scope_missing',
      'no_channel',
      'bad_state',
      'token_exchange_failed',
      'no_client',
      'zzz',
    ]) {
      const t = googleToast(c);
      expect(t.kind).toBe('error');
      expect(t.message.length).toBeGreaterThan(5);
    }
  });
  it('derives the card state', () => {
    expect(googleState(auth({ clientConfigured: false, clientSource: null }))).toBe('no-client');
    expect(googleState(auth({}))).toBe('no-account');
    expect(googleState(auth({ accounts: [acct(false)] }))).toBe('connected');
  });
  it('detects accounts needing reauth', () => {
    expect(anyNeedsReauth([acct(false)])).toBe(false);
    expect(anyNeedsReauth([acct(false), acct(true)])).toBe(true);
  });
  it('formats the connected date', () => {
    expect(connectedLabel('2026-01-02T12:00:00Z')).toMatch(/^Connected .*2026/);
    expect(connectedLabel('nope')).toBe('Connected');
  });
});
