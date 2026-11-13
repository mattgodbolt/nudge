import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ACCESS_PUBLIC_PATHS, checkAccess, checkExposure, checkRequest, registerSecurity } from './security.js';

const NAME = 'nudge.example.ts.net';
const base = { allowedHosts: [NAME], port: 4517 };
const post = { 'x-nudge': '1' };

describe('checkRequest behind tailscale serve', () => {
  it('still accepts loopback on the configured port only', () => {
    expect(checkRequest('GET', { host: '127.0.0.1:4517' }, base)).toBeNull();
    expect(checkRequest('GET', { host: '127.0.0.1:9999' }, base)?.body.code).toBe('bad_host');
  });

  it('accepts the allowed hostname on any port (the proxy talks on 443), case-insensitively', () => {
    expect(checkRequest('GET', { host: NAME }, base)).toBeNull();
    expect(checkRequest('GET', { host: NAME.toUpperCase() }, base)).toBeNull();
    expect(checkRequest('POST', { host: NAME, origin: `https://${NAME}`, ...post }, base)).toBeNull();
  });

  it('rejects other hostnames (DNS rebinding) and cross-site origins', () => {
    expect(checkRequest('GET', { host: 'evil.example.com' }, base)?.body.code).toBe('bad_host');
    expect(checkRequest('GET', { host: `x.${NAME}` }, base)?.body.code).toBe('bad_host');
    expect(checkRequest('POST', { host: NAME, origin: 'https://evil.example.com', ...post }, base)?.body.code).toBe(
      'bad_origin',
    );
  });

  it('with allowedUsers, requires the Tailscale identity on non-loopback hosts only', () => {
    const o = { ...base, allowedUsers: ['matt@example.com'] };
    expect(checkRequest('GET', { host: NAME }, o)?.body.code).toBe('bad_user');
    expect(checkRequest('GET', { host: NAME, 'tailscale-user-login': 'someone@else.com' }, o)?.body.code).toBe(
      'bad_user',
    );
    expect(checkRequest('GET', { host: NAME, 'tailscale-user-login': 'Matt@Example.com' }, o)).toBeNull();
    expect(checkRequest('GET', { host: '127.0.0.1:4517' }, o)).toBeNull();
  });

  it('is unchanged when nothing is configured', () => {
    expect(checkRequest('GET', { host: NAME }, { port: 4517 })?.body.code).toBe('bad_host');
  });
});

describe('checkExposure', () => {
  const ok = { host: '127.0.0.1', allowedHosts: [], allowedUsers: [] };
  it('accepts the default loopback setup silently', () => {
    expect(checkExposure(ok)).toEqual({ fatal: null, warnings: [] });
  });
  it('refuses a proxied hostname with no allowed users', () => {
    expect(checkExposure({ ...ok, allowedHosts: [NAME] }).fatal).toMatch(/NUDGE_ALLOWED_USERS/);
    expect(checkExposure({ ...ok, allowedHosts: [NAME], allowedUsers: ['me@example.com'] }).fatal).toBeNull();
  });
  it('warns, but does not refuse, on a non-loopback bind (containers need it)', () => {
    const r = checkExposure({ ...ok, host: '0.0.0.0' });
    expect(r.fatal).toBeNull();
    expect(r.warnings).toHaveLength(1);
  });
});

describe('Cloudflare Access hosts', () => {
  const ACCESS = 'nudge.example.com';
  const verifyAccess = async (t: string | undefined) =>
    t === 'good-matt' ? 'matt@example.org' : t === 'good-other' ? 'other@example.org' : null;
  const opts = {
    allowedHosts: [NAME],
    accessHosts: [ACCESS],
    allowedUsers: ['Matt@Example.org', 'tail@example.org'],
    verifyAccess,
    port: 4517,
  };
  const tsHeaders = { 'tailscale-user-login': 'tail@example.org' };

  it('accepts a verified token whose email is allowed (case-insensitive)', async () => {
    const h = { host: ACCESS, 'cf-access-jwt-assertion': 'good-matt' };
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
    const h = { host: ACCESS, ...tsHeaders, 'cf-access-authenticated-user-email': 'matt@example.org' };
    expect(checkRequest('GET', h, opts)).toBeNull(); // host itself is fine...
    expect((await checkAccess('GET', '/api/inbox', h, opts))?.body.code).toBe('bad_user'); // ...identity is not
  });

  it('ignores a valid Access token on the tailnet host, which still needs its own login header', async () => {
    const h = { host: NAME, 'cf-access-jwt-assertion': 'good-matt' };
    expect(checkRequest('GET', h, opts)?.status).toBe(403); // refused: Cloudflare traffic on a non-Access host
    expect(checkRequest('GET', { host: NAME, ...tsHeaders }, opts)).toBeNull();
    expect(await checkAccess('GET', '/api/inbox', { host: NAME, ...tsHeaders }, opts)).toBeNull();
  });

  it('fails closed when no verifier is configured', async () => {
    const h = { host: ACCESS, 'cf-access-jwt-assertion': 'good-matt' };
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
    expect(await checkAccess('GET', '/api/inbox', { host: NAME }, opts)).toBeNull();
  });
});

describe('Cloudflare traffic with a loopback Host', () => {
  const opts = { accessHosts: ['nudge.example.com'], allowedUsers: ['matt@example.org'], port: 4517 };
  it('is refused, so a tunnel that rewrites Host cannot skip the token check', () => {
    expect(checkRequest('GET', { host: '127.0.0.1:4517', 'cf-ray': 'abc' }, opts)?.body.code).toBe('bad_host');
    expect(checkRequest('GET', { host: '127.0.0.1:4517', 'cf-connecting-ip': '1.2.3.4' }, opts)?.body.code).toBe(
      'bad_host',
    );
  });
  it('leaves plain local requests alone, and does nothing when Access is not configured', () => {
    expect(checkRequest('GET', { host: '127.0.0.1:4517' }, opts)).toBeNull();
    expect(checkRequest('GET', { host: '127.0.0.1:4517', 'cf-ray': 'abc' }, { port: 4517 })).toBeNull();
  });
});

describe('checkExposure with Access', () => {
  const base = {
    host: '127.0.0.1',
    allowedHosts: [],
    allowedUsers: ['matt@example.org'],
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
      allowedHosts: [],
      accessHosts: ['nudge.example.com'],
      allowedUsers: ['matt@example.org'],
      verifyAccess: async (t) => (t === 'good' ? 'matt@example.org' : null),
    });
    app.get('/api/x', async () => ({ ok: true }));
    app.get('/sw.js', async () => 'sw');
    const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });
    expect((await get('/api/x', { host: 'nudge.example.com', 'cf-access-jwt-assertion': 'good' })).statusCode).toBe(
      200,
    );
    expect((await get('/api/x', { host: 'nudge.example.com' })).statusCode).toBe(403);
    expect(
      (await get('/api/x', { host: 'nudge.example.com', 'tailscale-user-login': 'matt@example.org' })).statusCode,
    ).toBe(403);
    expect((await get('/sw.js', { host: 'nudge.example.com' })).statusCode).toBe(200);
    expect((await get('/api/x', { host: 'evil.example.net', 'cf-access-jwt-assertion': 'good' })).statusCode).toBe(403);
    await app.close();
  });
});
