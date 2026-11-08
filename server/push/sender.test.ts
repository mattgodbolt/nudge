import { describe, expect, it } from 'vitest';
import { createRepo } from '../db/repo.js';
import { openDb } from '../db/db.js';
import { ensureVapidKeys, isAllowedPushEndpoint } from './sender.js';

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
    'https://web.push.apple.com/abc',
  ])('accepts %s', (u) => expect(isAllowedPushEndpoint(u)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/x',
    'https://localhost:9/x',
    'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evil.example/fcm.googleapis.com',
    'https://user:pw@fcm.googleapis.com/x',
    'not a url',
  ])('rejects %s', (u) => expect(isAllowedPushEndpoint(u)).toBe(false));
});

describe('ensureVapidKeys', () => {
  it('generates once and then returns the stored pair', () => {
    const repo = createRepo(openDb(':memory:'));
    const a = ensureVapidKeys(repo);
    expect(a.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(ensureVapidKeys(repo)).toEqual(a);
  });
});
