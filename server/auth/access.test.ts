import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAccessVerifier, type Jwk } from './access.js';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag-1234';
const NOW = 1_800_000_000_000;

function makeKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } as Jwk;
  return { privateKey, jwk };
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(
  key: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const h = enc({ alg: 'RS256', kid, typ: 'JWT', ...header });
  const p = enc(claims);
  const sig = createSign('sha256').update(`${h}.${p}`).sign(key).toString('base64url');
  return `${h}.${p}.${sig}`;
}

const good = (over: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  exp: NOW / 1000 + 600,
  nbf: NOW / 1000 - 10,
  email: 'Owner@Example.org',
  ...over,
});

function setup() {
  const a = makeKey('kid-a');
  const fetchKeys = vi.fn(async () => [a.jwk]);
  const verify = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchKeys, now: () => NOW });
  return { a, fetchKeys, verify };
}

describe('Cloudflare Access token verification', () => {
  it('accepts a valid token and returns the lower-cased email', async () => {
    const { a, verify } = setup();
    expect(await verify(sign(a.privateKey, 'kid-a', good()))).toBe('owner@example.org');
  });

  it('accepts aud given as a plain string', async () => {
    const { a, verify } = setup();
    expect(await verify(sign(a.privateKey, 'kid-a', good({ aud: AUD })))).toBe('owner@example.org');
  });

  it.each([
    ['wrong audience', { aud: ['other'] }],
    ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
    ['expired', { exp: NOW / 1000 - 120 }],
    ['not yet valid', { nbf: NOW / 1000 + 600 }],
    ['no exp', { exp: undefined }],
    ['no email', { email: undefined }],
    ['email without @', { email: 'owner' }],
  ])('rejects %s', async (_n, over) => {
    const { a, verify } = setup();
    expect(await verify(sign(a.privateKey, 'kid-a', good(over)))).toBeNull();
  });

  it('rejects a token signed with a different key', async () => {
    const { verify } = setup();
    const other = makeKey('kid-a');
    expect(await verify(sign(other.privateKey, 'kid-a', good()))).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { a, verify } = setup();
    const [h, , s] = sign(a.privateKey, 'kid-a', good()).split('.');
    expect(await verify(`${h}.${enc(good({ email: 'evil@example.org' }))}.${s}`)).toBeNull();
  });

  it('rejects alg none and HS256 even with a well-formed body', async () => {
    const { a, verify } = setup();
    const p = enc(good());
    expect(await verify(`${enc({ alg: 'none', kid: 'kid-a' })}.${p}.`)).toBeNull();
    expect(await verify(sign(a.privateKey, 'kid-a', good(), { alg: 'HS256' }))).toBeNull();
  });

  it('rejects garbage, empty and oversized input', async () => {
    const { verify } = setup();
    expect(await verify(undefined)).toBeNull();
    expect(await verify('')).toBeNull();
    expect(await verify('a.b')).toBeNull();
    expect(await verify('not a token at all')).toBeNull();
    expect(await verify('a'.repeat(9000))).toBeNull();
  });

  it('refetches once for an unknown kid, then accepts the rotated key', async () => {
    const a = makeKey('kid-a');
    const b = makeKey('kid-b');
    let t = NOW;
    let keys = [a.jwk];
    const fetchKeys = vi.fn(async () => keys);
    const verify = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchKeys, now: () => t });
    expect(await verify(sign(a.privateKey, 'kid-a', good()))).not.toBeNull();
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    keys = [a.jwk, b.jwk];
    t += 120_000;
    expect(await verify(sign(b.privateKey, 'kid-b', good({ exp: t / 1000 + 600, nbf: undefined })))).toBe(
      'owner@example.org',
    );
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it('does not refetch for unknown kids more than once a minute', async () => {
    const { a, fetchKeys, verify } = setup();
    await verify(sign(a.privateKey, 'kid-a', good())); // first fetch
    const ghost = makeKey('ghost');
    for (let i = 0; i < 5; i++) expect(await verify(sign(ghost.privateKey, 'ghost', good()))).toBeNull();
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the key fetch throws, but keeps keys it already has', async () => {
    const a = makeKey('kid-a');
    let t = NOW;
    let fail = false;
    const fetchKeys = vi.fn(async () => {
      if (fail) throw new Error('network down');
      return [a.jwk];
    });
    const verify = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchKeys, now: () => t });
    expect(await verify(sign(a.privateKey, 'kid-a', good()))).not.toBeNull();
    fail = true;
    t += 2 * 3_600_000;
    const fresh = good({ exp: t / 1000 + 600, nbf: undefined });
    expect(await verify(sign(a.privateKey, 'kid-a', fresh))).not.toBeNull(); // stale-but-known key still works
    const cold = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchKeys, now: () => t });
    expect(await cold(sign(a.privateKey, 'kid-a', fresh))).toBeNull(); // nothing cached: fail closed
  });

  it.each([
    ['aud as a number', { aud: 5 }],
    ['aud as an object', { aud: { [AUD]: true } }],
    ['exp as a string', { exp: String(NOW / 1000 + 600) }],
    ['nbf as a string', { nbf: '0' }],
    ['iss as an array', { iss: [`https://${TEAM}`] }],
    ['email as an array', { email: ['owner@example.org'] }],
  ])('rejects claim type confusion: %s', async (_n, over) => {
    const { a, verify } = setup();
    expect(await verify(sign(a.privateKey, 'kid-a', good(over)))).toBeNull();
  });

  it('rejects a wrong-typed kid, an empty signature and extra segments', async () => {
    const { a, verify } = setup();
    const t = sign(a.privateKey, 'kid-a', good());
    expect(await verify(sign(a.privateKey, 'kid-a', good(), { kid: 7 }))).toBeNull();
    expect(await verify(`${t.split('.').slice(0, 2).join('.')}.`)).toBeNull();
    expect(await verify(`${t}.extra`)).toBeNull();
  });
});
