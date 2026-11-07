import type { FastifyInstance } from 'fastify';
import { PostError, type AppDeps } from '../contracts.js';
import { asObject, bad, HttpError, notFound, str } from './util.js';

export interface AuthRouteOptions {
  /** Extra UI origins (Vite dev server) that may start the flow and receive the browser back. */
  devOrigins: string[];
}

/** The UI origin to return to: the request's own Origin if trusted, else the Host it was sent to. */
function returnOriginFor(origin: string | undefined, host: string | undefined, dev: string[]): string {
  const own = `http://${host ?? '127.0.0.1'}`;
  if (origin && (origin === own || dev.includes(origin))) return origin;
  return own;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps, opts: AuthRouteOptions): void {
  const { auth } = deps;

  app.get('/api/auth/status', async () => auth.status());

  app.post('/api/auth/start', async (req) => {
    // Only this trusted POST (Origin + X-Youtubey checked by security.ts) chooses where the callback returns to.
    const returnOrigin = returnOriginFor(req.headers.origin, req.headers.host, opts.devOrigins);
    try {
      return auth.start(returnOrigin);
    } catch (e) {
      if (e instanceof PostError && e.code === 'no_client') {
        throw new HttpError(400, 'No Google OAuth client is configured', 'no_client');
      }
      throw e;
    }
  });

  // A browser navigation from accounts.google.com: only the Host check applies (no Origin / custom header possible).
  // The single-use `state` from POST /start is what authenticates it.
  app.get('/api/auth/callback', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const { returnTo } = await auth.handleCallback({ code: s(q.code), state: s(q.state), error: s(q.error) });
    return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').redirect(returnTo, 302);
  });

  app.post('/api/auth/logout', async (req) => {
    const b = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const channelId = str(b, 'channelId', { optional: true });
    await auth.disconnect(channelId);
    return auth.status();
  });

  app.post('/api/auth/default', async (req) => {
    const channelId = str(asObject(req.body), 'channelId') as string;
    if (!auth.status().accounts.some((a) => a.channelId === channelId)) throw notFound('Google account');
    if (channelId.length > 64) throw bad('"channelId" is too long');
    auth.setDefault(channelId);
    return auth.status();
  });
}
