import { createSign, generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Jwk } from './auth/access.js';
import { loadConfig } from './config.js';
import {
  ACCESS_PUBLIC_PATHS,
  checkAccess,
  checkExposure,
  checkRequest,
  registerSecurity,
  securityOptions,
} from './security.js';

const ACCESS = 'nudge.example.com';
// The name `tailscale serve` used to front the app as. Tailscale is no longer a way in, so it is just another host.
const TAILNET = 'nudge.example.ts.net';
const base = { accessHosts: [ACCESS], allowedUsers: ['owner@example.org'], port: 4517 };
const post = { 'x-nudge': '1' };

describe('checkRequest', () => {
  it('accepts loopback on the configured port only', () => {
    expect(checkRequest('GET', { host: '127.0.0.1:4517' }, base)).toBeNull();
    expect(checkRequest('GET', { host: 'localhost:4517' }, base)).toBeNull();
    expect(checkRequest('GET', { host: '127.0.0.1:9999' }, base)?.body.code).toBe('bad_host');
  });

  it('accepts an Access hostname on any port (the tunnel talks on 443), case-insensitively', () => {
    expect(checkRequest('GET', { host: ACCESS }, base)).toBeNull();
    expect(checkRequest('GET', { host: ACCESS.toUpperCase() }, base)).toBeNull();
    expect(checkRequest('POST', { host: ACCESS, origin: `https://${ACCESS}`, ...post }, base)).toBeNull();
  });

  it('rejects other hostnames (DNS rebinding) and cross-site origins', () => {
    expect(checkRequest('GET', { host: 'evil.example.com' }, base)?.body.code).toBe('bad_host');
    expect(checkRequest('GET', { host: `x.${ACCESS}` }, base)?.body.code).toBe('bad_host');
    expect(checkRequest('POST', { host: ACCESS, origin: 'https://evil.example.com', ...post }, base)?.body.code).toBe(
      'bad_origin',
    );
  });

  it('no longer accepts a tailnet name, whatever Tailscale identity header it carries', () => {
    for (const extra of [{}, { 'tailscale-user-login': 'owner@example.org' }]) {
      expect(checkRequest('GET', { host: TAILNET, ...extra }, base)?.body.code).toBe('bad_host');
      expect(checkRequest('GET', { host: TAILNET, ...extra }, { port: 4517 })?.body.code).toBe('bad_host');
    }
  });

  it('accepts only loopback when nothing is configured', () => {
    expect(checkRequest('GET', { host: ACCESS }, { port: 4517 })?.body.code).toBe('bad_host');
    expect(checkRequest('GET', { host: '127.0.0.1:4517' }, { port: 4517 })).toBeNull();
  });
});

describe('checkExposure', () => {
  const ok = { host: '127.0.0.1', allowedUsers: [] };
  it('accepts the default loopback setup silently', () => {
    expect(checkExposure(ok)).toEqual({ fatal: null, warnings: [] });
  });
  it('warns, but does not refuse, on a non-loopback bind (containers need it)', () => {
    const r = checkExposure({ ...ok, host: '0.0.0.0' });
    expect(r.fatal).toBeNull();
    expect(r.warnings).toHaveLength(1);
  });
  it('warns, in one line each, about settings that are no longer used, and still starts', () => {
    const r = checkExposure({ ...ok, retiredVars: ['NUDGE_ALLOWED_HOSTS'] });
    expect(r.fatal).toBeNull();
    expect(r.warnings).toEqual([expect.stringMatching(/^NUDGE_ALLOWED_HOSTS is set but no longer used/)]);
    expect(r.warnings[0]).not.toContain('\n');
  });
});

describe('Cloudflare Access hosts', () => {
  const verifyAccess = async (t: string | undefined) =>
    t === 'good-owner' ? 'owner@example.org' : t === 'good-other' ? 'other@example.org' : null;
  const opts = {
    accessHosts: [ACCESS],
    allowedUsers: ['Owner@Example.org', 'second@example.org'],
    verifyAccess,
    port: 4517,
  };

  it('accepts a verified token whose email is allowed (case-insensitive)', async () => {
    const h = { host: ACCESS, 'cf-access-jwt-assertion': 'good-owner' };
    expect(checkRequest('GET', h, opts)).toBeNull();
    expect(await checkAccess('GET', '/api/inbox', h, opts)).toBeNull();
  });

  it('rejects a missing, invalid or unlisted-user token', async () => {
    for (const token of [undefined, 'junk', 'good-other']) {
      const h = { host: ACCESS, ...(token ? { 'cf-access-jwt-assertion': token } : {}) };
      expect((await checkAccess('GET', '/api/inbox', h, opts))?.body.code).toBe('bad_user');
    }
  });

  it('does not trust a forged Tailscale header or plain Cf-Access email on the Access host', async () => {
    const h = {
      host: ACCESS,
      'tailscale-user-login': 'owner@example.org',
      'cf-access-authenticated-user-email': 'owner@example.org',
    };
    expect(checkRequest('GET', h, opts)).toBeNull(); // host itself is fine...
    expect((await checkAccess('GET', '/api/inbox', h, opts))?.body.code).toBe('bad_user'); // ...identity is not
  });

  it('ignores a valid Access token on any other host', async () => {
    const h = { host: TAILNET, 'cf-access-jwt-assertion': 'good-owner' };
    expect(checkRequest('GET', h, opts)?.body.code).toBe('bad_host');
  });

  it('fails closed when no verifier is configured', async () => {
    const h = { host: ACCESS, 'cf-access-jwt-assertion': 'good-owner' };
    expect((await checkAccess('GET', '/api/inbox', h, { ...opts, verifyAccess: undefined }))?.body.code).toBe(
      'bad_user',
    );
  });

  it('lets only the listed static files through without a token, and only on GET/HEAD', async () => {
    const h = { host: ACCESS };
    for (const p of ACCESS_PUBLIC_PATHS) expect(await checkAccess('GET', `${p}?v=1`, h, opts)).toBeNull();
    expect(await checkAccess('HEAD', '/manifest.webmanifest', h, opts)).toBeNull();
    expect((await checkAccess('POST', '/manifest.webmanifest', h, opts))?.body.code).toBe('bad_user');
    for (const p of [
      '/',
      '/inbox',
      '/api/inbox',
      '/manifest.webmanifest/../api/inbox',
      '/sw.js.map',
      '/data/nudge.db',
    ]) {
      expect((await checkAccess('GET', p, h, opts))?.body.code).toBe('bad_user');
    }
  });

  it('is a no-op for hosts that are not Access hosts', async () => {
    expect(await checkAccess('GET', '/api/inbox', { host: '127.0.0.1:4517' }, opts)).toBeNull();
    expect(await checkAccess('GET', '/api/inbox', { host: TAILNET }, opts)).toBeNull();
  });
});

describe('Cloudflare traffic with a loopback Host', () => {
  const opts = { accessHosts: ['nudge.example.com'], allowedUsers: ['owner@example.org'], port: 4517 };
  it('is refused, so a tunnel that rewrites Host cannot skip the token check', () => {
    expect(checkRequest('GET', { host: '127.0.0.1:4517', 'cf-ray': 'abc' }, opts)?.body.code).toBe('bad_host');
    expect(checkRequest('GET', { host: '127.0.0.1:4517', 'cf-connecting-ip': '1.2.3.4' }, opts)?.body.code).toBe(
      'bad_host',
    );
  });
  it('leaves plain local requests alone (the deploy healthcheck, an ssh -L tunnel, the Vite proxy)', () => {
    expect(checkRequest('GET', { host: '127.0.0.1:4517' }, opts)).toBeNull();
    expect(checkRequest('GET', { host: 'localhost:4517', 'user-agent': 'node' }, { port: 4517 })).toBeNull();
    expect(
      checkRequest('POST', { host: '127.0.0.1:4517', origin: 'http://127.0.0.1:4517', 'x-nudge': '1' }, { port: 4517 }),
    ).toBeNull();
  });
  it('refuses any proxy or Cloudflare header on a loopback Host, whether or not Access is configured', () => {
    const proxied = [
      { 'cf-ray': 'abc' },
      { 'cf-ipcountry': 'GB' },
      { 'cf-access-jwt-assertion': 'x' },
      { 'cdn-loop': 'cloudflare' },
      { 'x-forwarded-for': '1.2.3.4' },
      { 'x-forwarded-host': 'evil.example' },
      { 'x-forwarded-proto': 'https' },
      { forwarded: 'for=1.2.3.4' },
      { via: '1.1 proxy' },
    ];
    for (const o of [opts, { port: 4517 }, {}]) {
      for (const extra of proxied) {
        expect(checkRequest('GET', { host: '127.0.0.1:4517', ...extra }, o)?.body.code, JSON.stringify(extra)).toBe(
          'bad_host',
        );
      }
    }
  });
  it('still lets proxied traffic reach an Access host', () => {
    expect(
      checkRequest('GET', { host: 'nudge.example.com', 'cf-ray': 'abc', 'x-forwarded-for': '1.2.3.4' }, opts),
    ).toBeNull();
  });
});

describe('checkExposure with Access', () => {
  const base = {
    host: '127.0.0.1',
    allowedUsers: ['owner@example.org'],
    accessHosts: ['nudge.example.com'],
    accessTeamDomain: 'team.cloudflareaccess.com',
    accessAud: 'aud',
  };
  it('accepts a complete setup', () => {
    expect(checkExposure(base).fatal).toBeNull();
  });
  it('refuses incomplete or inconsistent setups', () => {
    expect(checkExposure({ ...base, allowedUsers: [] }).fatal).toMatch(/ALLOWED_USERS/);
    expect(checkExposure({ ...base, accessAud: '' }).fatal).toMatch(/ACCESS_AUD/);
    expect(checkExposure({ ...base, accessTeamDomain: '' }).fatal).toMatch(/TEAM_DOMAIN/);
    expect(checkExposure({ ...base, accessHosts: [] }).fatal).toMatch(/ACCESS_HOSTS is empty/);
    expect(checkExposure({ ...base, accessTeamDomain: 'evil.example.net' }).fatal).toMatch(/cloudflareaccess\.com/);
  });
});

describe('registerSecurity hook with Access', () => {
  it('lets a verified request through and rejects forged ones end to end', async () => {
    const app = Fastify();
    registerSecurity(app, {
      accessHosts: ['nudge.example.com'],
      allowedUsers: ['owner@example.org'],
      verifyAccess: async (t) => (t === 'good' ? 'owner@example.org' : null),
    });
    app.get('/api/x', async () => ({ ok: true }));
    app.get('/sw.js', async () => 'sw');
    const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });
    expect((await get('/api/x', { host: 'nudge.example.com', 'cf-access-jwt-assertion': 'good' })).statusCode).toBe(
      200,
    );
    expect((await get('/api/x', { host: 'nudge.example.com' })).statusCode).toBe(403);
    expect(
      (await get('/api/x', { host: 'nudge.example.com', 'tailscale-user-login': 'owner@example.org' })).statusCode,
    ).toBe(403);
    expect((await get('/sw.js', { host: 'nudge.example.com' })).statusCode).toBe(200);
    expect((await get('/api/x', { host: 'evil.example.net', 'cf-access-jwt-assertion': 'good' })).statusCode).toBe(403);
    await app.close();
  });
});

// The production .env was written when Tailscale was a way in, and still sets NUDGE_ALLOWED_HOSTS. The server must keep
// starting with it (a deploy that refused to start would take the app down), and Cloudflare Access, the only way in now,
// must keep working. This runs the same steps as main(): loadConfig, checkExposure, securityOptions.
describe('a deployment whose .env predates the end of Tailscale', () => {
  const TEAM = 'team.cloudflareaccess.com';
  const AUD = 'aud-tag';
  const NOW = 1_800_000_000_000;
  const env = {
    NUDGE_HOST: '0.0.0.0',
    NUDGE_ALLOWED_HOSTS: TAILNET,
    NUDGE_ALLOWED_USERS: 'Owner@Example.org',
    NUDGE_ACCESS_HOSTS: ACCESS,
    NUDGE_ACCESS_TEAM_DOMAIN: TEAM,
    NUDGE_ACCESS_AUD: AUD,
  };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' } as Jwk;
  const token = (email: string) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({
      iss: `https://${TEAM}`,
      aud: [AUD],
      exp: NOW / 1000 + 600,
      nbf: NOW / 1000 - 10,
      email,
    })}`;
    return `${head}.${createSign('sha256').update(head).sign(privateKey).toString('base64url')}`;
  };

  it('starts, with a one-line warning that NUDGE_ALLOWED_HOSTS is no longer used', () => {
    const config = loadConfig(env);
    const { fatal, warnings } = checkExposure(config);
    expect(fatal).toBeNull();
    const retired = warnings.filter((w) => w.includes('NUDGE_ALLOWED_HOSTS'));
    expect(retired).toHaveLength(1);
    expect(retired[0]).not.toContain('\n');
  });

  it('lets a request with a valid Access token for an allowed email in, and nothing else', async () => {
    const config = loadConfig(env);
    const app = Fastify();
    registerSecurity(app, securityOptions(config, { fetchKeys: async () => [jwk], now: () => NOW }));
    app.get('/api/x', async () => ({ ok: true }));
    const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/x', headers });
    expect((await get({ host: ACCESS, 'cf-access-jwt-assertion': token('owner@example.org') })).statusCode).toBe(200);
    expect((await get({ host: ACCESS, 'cf-access-jwt-assertion': token('someone@example.org') })).statusCode).toBe(403);
    expect((await get({ host: ACCESS })).statusCode).toBe(403);
    expect((await get({ host: TAILNET, 'tailscale-user-login': 'owner@example.org' })).statusCode).toBe(403);
    await app.close();
  });
});
