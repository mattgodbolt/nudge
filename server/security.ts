import type { FastifyInstance } from 'fastify';
import { CLIENT_HEADER } from '../shared/api.js';
import type { ApiError } from '../shared/types.js';

const LOOPBACK = /^(127\.0\.0\.1|localhost)$/i;

export interface SecurityOptions {
  /** If set, Host must carry exactly this port. */
  port?: number;
  /** Extra allowed Origin values (e.g. the Vite dev server). */
  extraOrigins?: string[];
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
  // Blocks DNS rebinding: a rebound hostname is never 127.0.0.1/localhost.
  if (!host || !LOOPBACK.test(host.hostname) || (opts.port !== undefined && host.port !== String(opts.port))) {
    return reject(403, 'Forbidden host', 'bad_host');
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
