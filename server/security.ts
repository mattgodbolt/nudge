import type { FastifyInstance } from 'fastify';
import { CLIENT_HEADER } from '../shared/api.js';
import type { ApiError } from '../shared/types.js';
import { createAccessVerifier, type AccessVerifierOptions } from './auth/access.js';
import type { Config } from './config.js';

const LOOPBACK = /^(127\.0\.0\.1|localhost)$/i;

export interface SecurityOptions {
  /** If set, a loopback Host must carry exactly this port. */
  port?: number;
  /** Extra allowed Origin values (e.g. the Vite dev server). */
  extraOrigins?: string[];
  /** Emails allowed in through Cloudflare Access (exact, case-insensitive). Required when accessHosts is set. */
  allowedUsers?: string[];
  /**
   * Hostnames behind Cloudflare Access: the only names accepted in Host besides loopback. Requests to them are
   * authenticated by the signed Cf-Access-Jwt-Assertion token (see verifyAccess); the token means nothing on any
   * other host.
   */
  accessHosts?: string[];
  /** Verifies the Access token and returns the lower-cased email it proves, or null. Required when accessHosts is set. */
  verifyAccess?: (token: string | undefined) => Promise<string | null>;
}

/** The options the server runs with, built from its config (a function so tests exercise the same wiring). */
export function securityOptions(
  config: Pick<Config, 'port' | 'allowedUsers' | 'accessHosts' | 'accessTeamDomain' | 'accessAud'>,
  access: Pick<AccessVerifierOptions, 'fetchKeys' | 'now'> = {},
): SecurityOptions {
  return {
    port: config.port || undefined,
    allowedUsers: config.allowedUsers,
    accessHosts: config.accessHosts,
    verifyAccess:
      config.accessHosts.length > 0
        ? createAccessVerifier({ teamDomain: config.accessTeamDomain, aud: config.accessAud, ...access })
        : undefined,
  };
}

/**
 * Static files a browser fetches without credentials (manifest, icons, service worker), which Access is told to let
 * through unauthenticated so the PWA can install. Exact paths, GET/HEAD only, and only on Access hosts.
 */
export const ACCESS_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/manifest.webmanifest',
  '/sw.js',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/badge-96.png',
  '/logo-120.png',
]);

const CLOUDFLARE_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cdn-loop', 'cf-access-jwt-assertion'];

function hostnameOf(headers: Record<string, string | string[] | undefined>): string | null {
  const h = typeof headers.host === 'string' ? parseHost(headers.host) : null;
  return h ? h.hostname.toLowerCase() : null;
}

function isAccessHost(headers: Record<string, string | string[] | undefined>, opts: SecurityOptions): boolean {
  const name = hostnameOf(headers);
  return name !== null && (opts.accessHosts ?? []).some((h) => h.toLowerCase() === name);
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
  const accessHost = isAccessHost(headers, opts);
  if (!host || !(accessHost || loopback) || (loopback && opts.port !== undefined && host.port !== String(opts.port))) {
    return reject(403, 'Forbidden host', 'bad_host');
  }
  // Defence against a tunnel rewritten to send a loopback Host (which skips the token check): traffic that came
  // through Cloudflare carries these headers, and local clients never do.
  if (!accessHost && (opts.accessHosts ?? []).length > 0 && CLOUDFLARE_HEADERS.some((h) => h in headers)) {
    return reject(403, 'Forbidden host', 'bad_host');
  }
  // Access hosts are authenticated by checkAccess (it needs an async signature check).
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

/**
 * The Cloudflare Access half of the check, for requests whose Host is an Access host (anything else passes through).
 * The identity comes only from the verified token; it must be one of allowedUsers (exact email, never a domain).
 * Fails closed: no verifier, no token, a bad token or an unlisted email all reject.
 */
export async function checkAccess(
  method: string,
  url: string,
  headers: Record<string, string | string[] | undefined>,
  opts: SecurityOptions,
): Promise<{ status: number; body: ApiError } | null> {
  if (!isAccessHost(headers, opts)) return null;
  const path = url.split('?')[0] ?? '';
  if ((method === 'GET' || method === 'HEAD') && ACCESS_PUBLIC_PATHS.has(path)) return null;
  const token = headers['cf-access-jwt-assertion'];
  const email = opts.verifyAccess ? await opts.verifyAccess(typeof token === 'string' ? token : undefined) : null;
  const allowed = (opts.allowedUsers ?? []).map((u) => u.trim().toLowerCase());
  if (!email || !allowed.includes(email)) {
    return reject(403, 'Not signed in through Cloudflare Access as an allowed user', 'bad_user');
  }
  return null;
}

export function registerSecurity(app: FastifyInstance, opts: SecurityOptions): void {
  app.addHook('onRequest', async (req, reply) => {
    const rejection =
      checkRequest(req.method, req.headers, opts) ?? (await checkAccess(req.method, req.url, req.headers, opts));
    if (rejection) return reply.code(rejection.status).send(rejection.body);
  });
}

/**
 * Startup sanity check on how the app is exposed. Naming an Access hostname without saying who may use it would admit
 * everyone Access lets in (the app can post replies as the owner), so that and an incomplete Access setup are refused
 * outright. A non-loopback bind is flagged, and settings that are no longer read are named so they can be removed.
 */
export function checkExposure(cfg: {
  host: string;
  allowedUsers: string[];
  accessHosts?: string[];
  accessTeamDomain?: string;
  accessAud?: string;
  retiredVars?: string[];
}): {
  fatal: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  let fatal: string | null = null;
  const accessHosts = cfg.accessHosts ?? [];
  const team = cfg.accessTeamDomain ?? '';
  const aud = cfg.accessAud ?? '';
  if (accessHosts.length > 0 && cfg.allowedUsers.length === 0) {
    fatal =
      'NUDGE_ACCESS_HOSTS is set but NUDGE_ALLOWED_USERS is empty, which would let everyone Cloudflare Access lets ' +
      'in use this app. Set NUDGE_ALLOWED_USERS to the email(s) allowed.';
  } else if (accessHosts.length > 0 && (!team || !aud)) {
    fatal = 'NUDGE_ACCESS_HOSTS needs NUDGE_ACCESS_TEAM_DOMAIN and NUDGE_ACCESS_AUD, or no token could be verified.';
  } else if (accessHosts.length === 0 && (team || aud)) {
    fatal =
      'NUDGE_ACCESS_TEAM_DOMAIN / NUDGE_ACCESS_AUD are set but NUDGE_ACCESS_HOSTS is empty, so nothing would use them.';
  } else if (team && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.cloudflareaccess\.com$/.test(team)) {
    fatal = 'NUDGE_ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com.';
  }
  for (const name of cfg.retiredVars ?? []) {
    warnings.push(`${name} is set but no longer used (Tailscale is no longer a way in); remove it from your .env.`);
  }
  if (!LOOPBACK.test(cfg.host)) {
    warnings.push(
      `Listening on ${cfg.host}, not loopback. This is only safe if the port is published to 127.0.0.1 alone (as ` +
        'compose.yaml does) or firewalled: anyone who can reach it with a loopback Host header is treated as local.',
    );
  }
  return { fatal, warnings };
}
