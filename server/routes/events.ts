import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '../../shared/types.js';
import type { PingPayload } from '../../shared/build.js';
import type { AppDeps } from '../contracts.js';

const PING_MS = 20_000;

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps, pingMs = PING_MS): void {
  const cleanups = new Set<() => void>();

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const send = (e: ServerEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const unsubscribe = deps.bus.subscribe(send);
    // A comment keeps proxies from closing an idle stream; the named event is what the page's watchdog listens for
    // (EventSource never shows comments), so a stream that looks open but is dead gets noticed and reopened.
    // The ping also names the web build being served, so a page that has been open since before a deploy notices.
    const ping = () => {
      const payload: PingPayload = { build: deps.buildId?.() ?? null };
      res.write(`: ping\n\nevent: ping\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    // One straight away too: after a deploy the server restarts, the page's stream reconnects, and this is what tells
    // it so without waiting out a whole interval.
    ping();
    const pinger = setInterval(ping, pingMs);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(pinger);
      unsubscribe();
      cleanups.delete(cleanup);
      if (!res.writableEnded) res.end();
    };
    cleanups.add(cleanup);
    req.raw.on('close', cleanup);
    res.on('error', cleanup);
  });

  // Open SSE streams would otherwise keep app.close() waiting forever.
  app.addHook('onClose', async () => {
    for (const c of [...cleanups]) c();
  });
}
