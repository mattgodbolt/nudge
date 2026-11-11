import { describe, expect, it } from 'vitest';
import { checkExposure, checkRequest } from './security.js';

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
