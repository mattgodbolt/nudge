import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiError } from '../shared/types.js';
import type { AppDeps } from './contracts.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerPushRoutes } from './routes/push.js';
import { registerGithubRoutes } from './routes/github.js';
import { registerTodoRoutes } from './routes/todos.js';
import { registerUsageRoutes } from './routes/usage.js';
import { HttpError } from './routes/util.js';
import { registerSecurity, type SecurityOptions } from './security.js';

export interface BuildAppOptions extends SecurityOptions {
  /** SSE keep-alive interval, overridable for tests. */
  pingMs?: number;
}

const VITE_DEV_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/** The Vite dev server may POST to the API in development only; a production server trusts just its own origin. */
export function devOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.NODE_ENV === 'production' ? [] : VITE_DEV_ORIGINS;
}

export function buildApp(deps: AppDeps, opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, forceCloseConnections: true });

  registerSecurity(app, { extraOrigins: devOrigins(), ...opts });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    if (err instanceof HttpError) {
      ({ status, code, message } = { status: err.status, code: err.code, message: err.message });
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      // Fastify's own client errors: malformed JSON, wrong content type, body too large...
      status = err.statusCode;
      code = 'bad_request';
      message = err.message;
    } else {
      console.error(err);
    }
    const body: ApiError = { error: message, code };
    return reply.code(status).send(body);
  });

  registerApiRoutes(app, deps);
  registerAuthRoutes(app, deps, { devOrigins: opts.extraOrigins ?? devOrigins() });
  registerPushRoutes(app, deps);
  registerGithubRoutes(app, deps);
  registerTodoRoutes(app, deps);
  registerUsageRoutes(app, deps);
  registerEventRoutes(app, deps, opts.pingMs);

  const staticDir = deps.staticDir && existsSync(join(deps.staticDir, 'index.html')) ? deps.staticDir : null;
  if (staticDir) {
    void app.register(fastifyStatic, { root: staticDir });
  }
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url === '/api';
    if (staticDir && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
      return reply.type('text/html').sendFile('index.html');
    }
    const body: ApiError = { error: 'Not found', code: 'not_found' };
    return reply.code(404).send(body);
  });

  return app;
}
