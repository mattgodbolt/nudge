import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DEFAULT_INSIGHTS_RANGE, INSIGHTS_RANGES, type Insights } from '../../shared/insights.js';
import type { AppDeps } from '../contracts.js';
import { bad, oneOf, tz } from './util.js';

/**
 * Insights (docs/INSIGHTS.md): GET only, behind the same host/origin/client checks as every API route. Reads the
 * history through the insights reader and writes nothing.
 */
export function registerInsightsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const reader = deps.insights;
  if (!reader) return;

  app.get('/api/insights', async (req: FastifyRequest): Promise<Insights> => {
    const q = req.query as Record<string, unknown>;
    const range = oneOf(
      q.range === undefined || q.range === '' ? DEFAULT_INSIGHTS_RANGE : q.range,
      'range',
      INSIGHTS_RANGES,
    );
    const zone = tz(q.tz);
    try {
      return reader.report(range, zone);
    } catch (e) {
      if (e instanceof RangeError) throw bad(`Unknown time zone "${zone}"`);
      throw e;
    }
  });
}
