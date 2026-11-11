import type { FastifyInstance } from 'fastify';
import { CLIENT_HEADER } from '../shared/api.js';
import type { ApiError } from '../shared/types.js';

const LOOPBACK = /^(127\.0\.0\.1|localhost)$/i;

export interface SecurityOptions {
  /** If set, Host must carry exactly this port. */
  port?: number;
  /** Extra allowed Origin values (e.g. the Vite dev server). */
  extraOrigins?: string[];
  /**
   * Extra hostnames accepted in Host besides loopback, e.g. the Tailscale name of the machine when `tailscale serve`
   * fronts the app. The port check is skipped for these (the proxy talks on 443, not our port).
   */
  allowedHosts?: string[];
  /**
   * If non-empty, a request to an allowed (non-loopback) host must carry a Tailscale-User-Login header naming one of
   * these logins. `tailscale serve` sets it from the caller's tailnet identity and strips any client-supplied value;
   * it is only trustworthy because the app listens on loopback, so only the local proxy can reach it.
   */
  allowedUsers?: string[];
}

function parseHost(host: string | undefined): { hostname: string; port: string } | null {
  if (!host) return null;
  const m = /^([^:]+)(?::(\d+))?$/.exec(host);
  return m ? { hostname: m[1]!, port: m[2] ?? '' } : null;
}

function reject(status: number, error: string, code: string): { status: number; body: ApiError } {
  return { status, body: { error, code } };
}

/** Pure check so it can be unit tested; returns a rejection or null. */
export function checkRequest(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  opts: SecurityOptions,
): { status: number; body: ApiError } | null {
  const hostHeader = typeof headers.host === 'string' ? headers.host : undefined;
  const host = parseHost(hostHeader);
  // Blocks DNS rebinding: a rebound hostname is never 127.0.0.1/localhost or one we were told to expect.
  const loopback = host !== null && LOOPBACK.test(host.hostname);
  const allowed =
    host !== null && (opts.allowedHosts ?? []).some((h) => h.toLowerCase() === host.hostname.toLowerCase());
  if (!host || !(allowed || loopback) || (loopback && opts.port !== undefined && host.port !== String(opts.port))) {
    return reject(403, 'Forbidden host', 'bad_host');
  }
  if (allowed && (opts.allowedUsers ?? []).length > 0) {
    const login = headers['tailscale-user-login'];
    const who = typeof login === 'string' ? login.toLowerCase() : '';
    if (!(opts.allowedUsers ?? []).some((u) => u.toLowerCase() === who)) {
      return reject(403, 'Not signed in to the tailnet as an allowed user', 'bad_user');
    }
  }
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const origin = headers.origin;
  if (origin !== undefined) {
    const o = typeof origin === 'string' ? origin : '';
    let originHost: string | null = null;
    try {
      originHost = new URL(o).host;
    } catch {
      /* invalid -> rejected below */
    }
    const ok = originHost !== null && (originHost === hostHeader || (opts.extraOrigins ?? []).includes(o));
    if (!ok) return reject(403, 'Forbidden origin', 'bad_origin');
  }
  if (headers[CLIENT_HEADER.toLowerCase()] !== '1') {
    return reject(403, `Missing ${CLIENT_HEADER} header`, 'missing_client_header');
  }
  return null;
}

export function registerSecurity(app: FastifyInstance, opts: SecurityOptions): void {
  app.addHook('onRequest', async (req, reply) => {
    const rejection = checkRequest(req.method, req.headers, opts);
    if (rejection) return reply.code(rejection.status).send(rejection.body);
  });
}

/**
 * Startup sanity check on how the app is exposed. The Tailscale login header is only trustworthy when the sole route
 * in is the local proxy, so a non-loopback bind is flagged, and naming a proxied hostname without saying who may use
 * it would admit every device on the tailnet (the app can post replies as the owner), which is refused outright.
 */
export function checkExposure(cfg: { host: string; allowedHosts: string[]; allowedUsers: string[] }): {
  fatal: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  let fatal: string | null = null;
  if (cfg.allowedHosts.length > 0 && cfg.allowedUsers.length === 0) {
    fatal =
      'NUDGE_ALLOWED_HOSTS is set but NUDGE_ALLOWED_USERS is empty, which would let every device on the tailnet use ' +
      'this app. Set NUDGE_ALLOWED_USERS to your Tailscale login.';
  }
  if (!LOOPBACK.test(cfg.host)) {
    warnings.push(
      `Listening on ${cfg.host}, not loopback. This is only safe if the port is published to 127.0.0.1 alone (as ` +
        'compose.yaml does) or firewalled: anyone who can reach it can send a forged Tailscale-User-Login header.',
    );
  }
  return { fatal, warnings };
}
