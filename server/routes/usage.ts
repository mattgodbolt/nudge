import type { FastifyInstance } from 'fastify';
import { MAX_KEYS_PER_REQUEST, sanitizeCounts, type UsagePostResult } from '../../shared/usage.js';
import type { AppDeps } from '../contracts.js';
import { asObject, bad, int } from './util.js';

const MAX_DAYS = 366;

/**
 * Internal usage analytics: counts of feature use, nothing else. The browser batches increments here; the allow-list
 * in shared/usage.ts decides what may be stored. Host, Origin and the client header are enforced for every route by
 * registerSecurity, so nothing extra is needed here.
 */
export function registerUsageRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { usage } = deps.repo;

  app.post('/api/usage', async (req): Promise<UsagePostResult> => {
    const b = asObject(req.body);
    const counts = b.counts;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw bad('"counts" must be an object');
    if (Object.keys(counts).length > MAX_KEYS_PER_REQUEST)
      throw bad(`At most ${MAX_KEYS_PER_REQUEST} keys per request`);
    const { accepted, rejected } = sanitizeCounts(counts);
    const { stored } = usage.add(accepted);
    return { accepted: stored, rejected };
  });

  app.get('/api/usage', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const days = q.days === undefined ? 30 : int(q.days, 'days', { min: 1, max: MAX_DAYS });
    return usage.report(days);
  });

  app.delete('/api/usage', async (_req, reply) => {
    usage.reset();
    return reply.code(204).send();
  });
}
