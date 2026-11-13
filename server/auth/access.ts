import { createPublicKey, verify as cryptoVerify, constants, type KeyObject } from 'node:crypto';

/**
 * Verification of the signed token Cloudflare Access adds to every request it lets through
 * (`Cf-Access-Jwt-Assertion`). The signature is the security boundary: the plain
 * `Cf-Access-Authenticated-User-Email` header is never used because anything that can reach the port can forge it.
 *
 * Done by hand with node:crypto (RS256 only) rather than pulling in a JWT library for one algorithm. Every failure
 * returns null: the caller treats "cannot prove it" as "not signed in".
 */

const LEEWAY_S = 30;
/** Known keys are reused for this long before a refresh is attempted. */
const KEY_TTL_MS = 60 * 60_000;
/** An unknown key id triggers a refetch, but never more often than this, so junk tokens cannot make us hammer Cloudflare. */
const MIN_REFETCH_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_TOKEN_BYTES = 8_192;

export interface Jwk {
  kid?: unknown;
  kty?: unknown;
  n?: unknown;
  e?: unknown;
  [k: string]: unknown;
}

export interface AccessVerifierOptions {
  /** e.g. `team.cloudflareaccess.com` (no scheme). */
  teamDomain: string;
  /** The Access application's audience tag. */
  aud: string;
  /** Injectable for tests. Resolves the JWKS `keys` array or throws. */
  fetchKeys?: (teamDomain: string) => Promise<Jwk[]>;
  now?: () => number;
}

async function defaultFetchKeys(teamDomain: string): Promise<Jwk[]> {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`certs endpoint answered ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error('certs endpoint returned no keys');
  return body.keys as Jwk[];
}

const b64url = (s: string): Buffer | null => (/^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, 'base64url') : null);

function parseJson(buf: Buffer | null): Record<string, unknown> | null {
  if (!buf) return null;
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createAccessVerifier(
  opts: AccessVerifierOptions,
): (token: string | undefined) => Promise<string | null> {
  const fetchKeys = opts.fetchKeys ?? defaultFetchKeys;
  const now = opts.now ?? Date.now;
  const issuer = `https://${opts.teamDomain}`;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= (async () => {
      await Promise.resolve(); // so `inflight` is assigned before any synchronous failure reaches the finally block
      try {
        const fresh = new Map<string, KeyObject>();
        for (const jwk of await fetchKeys(opts.teamDomain)) {
          if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
          try {
            fresh.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
          } catch {
            /* skip a malformed key, keep the rest */
          }
        }
        if (fresh.size > 0) keys = fresh;
      } catch {
        /* keep whatever we had: a known key still verifies, an unknown one fails closed */
      } finally {
        fetchedAt = now();
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | null> {
    const age = now() - fetchedAt;
    if (!keys.has(kid) && age >= MIN_REFETCH_MS) await refresh();
    else if (keys.has(kid) && age >= KEY_TTL_MS) await refresh();
    return keys.get(kid) ?? null;
  }

  return async (token) => {
    try {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [h, p, s] = parts as [string, string, string];
      const header = parseJson(b64url(h));
      if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
      const key = await keyFor(header.kid);
      if (!key) return null;
      const sig = b64url(s);
      if (!sig || sig.length === 0) return null;
      const ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key, padding: constants.RSA_PKCS1_PADDING }, sig);
      if (!ok) return null;

      const claims = parseJson(b64url(p));
      if (!claims) return null;
      const nowS = Math.floor(now() / 1000);
      if (claims.iss !== issuer) return null;
      const aud = claims.aud;
      if (!(aud === opts.aud || (Array.isArray(aud) && aud.includes(opts.aud)))) return null;
      if (typeof claims.exp !== 'number' || !(claims.exp + LEEWAY_S > nowS)) return null;
      if (claims.nbf !== undefined && !(typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S <= nowS)) return null;
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
      return email.includes('@') ? email : null;
    } catch {
      return null;
    }
  };
}
