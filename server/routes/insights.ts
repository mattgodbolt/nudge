import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DEFAULT_INSIGHTS_RANGE, INSIGHTS_RANGES, type Insights, type InsightsRange } from '../../shared/insights.js';
import type { AppDeps } from '../contracts.js';
import { bad } from './util.js';

/**
 * Insights (docs/INSIGHTS.md): GET only, behind the same host/origin/client checks as every API route. Reads the
 * history through the insights reader and writes nothing.
 */
export function registerInsightsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const reader = deps.insights;
  if (!reader) return;

  app.get('/api/insights', async (req: FastifyRequest): Promise<Insights> => {
    const q = req.query as Record<string, unknown>;
    const range = q.range === undefined || q.range === '' ? DEFAULT_INSIGHTS_RANGE : q.range;
    if (typeof range !== 'string' || !(INSIGHTS_RANGES as readonly string[]).includes(range))
      throw bad(`"range" must be one of ${INSIGHTS_RANGES.join(', ')}`);
    const tz = q.tz === undefined || q.tz === '' ? 'UTC' : q.tz;
    if (typeof tz !== 'string' || tz.length > 64) throw bad('"tz" must be an IANA time zone name');
    try {
      return reader.report(range as InsightsRange, tz);
    } catch (e) {
      if (e instanceof RangeError) throw bad(`Unknown time zone "${tz}"`);
      throw e;
    }
  });
}
