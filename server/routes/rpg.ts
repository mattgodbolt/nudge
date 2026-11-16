import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RpgClaim, RpgSheet } from '../../shared/types.js';
import type { AppDeps, RpgStored } from '../contracts.js';
import { planClaim } from '../db/rpg.js';
import { HttpError, asObject, bad, int } from './util.js';

/**
 * Adventure mode (docs/RPG.md). Cosmetic only: these routes read the history through the RPG reader and write nothing
 * but the mode's own `rpg` settings row (what has been announced, and the browser's time zone).
 */
export function registerRpgRoutes(app: FastifyInstance, deps: AppDeps): void {
  const reader = deps.rpg;
  if (!reader) return;
  const { repo } = deps;

  const tzOf = (v: unknown): string => {
    if (v === undefined || v === null || v === '') return 'UTC';
    if (typeof v !== 'string' || v.length > 64) throw bad('"tz" must be an IANA time zone name');
    return v;
  };
  const stored = (): RpgStored => {
    const r = repo.getSettings().rpg;
    if (!r.enabled) throw new HttpError(409, 'Adventure mode is off', 'rpg_off');
    return r;
  };
  /** A different zone from last time is remembered with the one before it, so days near the change are judged kindly. */
  const zones = (r: RpgStored, tz: string) => ({
    tz,
    prevTz: r.tz && r.tz !== tz ? r.tz : r.prevTz && r.prevTz !== tz ? r.prevTz : null,
  });
  const sheetFor = (r: RpgStored, tz: string): RpgSheet => {
    try {
      return reader.sheet(tz, r.title, zones(r, tz).prevTz);
    } catch (e) {
      if (e instanceof RangeError) throw bad(`Unknown time zone "${tz}"`);
      throw e;
    }
  };

  app.get('/api/rpg', async (req: FastifyRequest) => {
    const q = req.query as Record<string, unknown>;
    return sheetFor(stored(), tzOf(q.tz));
  });

  // Synchronous from the read to the write, so two devices claiming at once cannot both be handed the same news.
  app.post('/api/rpg/claim', async (req): Promise<RpgClaim> => {
    const b = req.body === undefined || req.body === null ? {} : asObject(req.body);
    const tz = tzOf(b.tz);
    const r = stored();
    const sheet = sheetFor(r, tz);
    const { news, seen } = planClaim(sheet, r.seen);
    const z = zones(r, tz);
    if (JSON.stringify(seen) !== JSON.stringify(r.seen) || r.tz !== z.tz || r.prevTz !== z.prevTz) {
      repo.updateSettings({ rpg: { ...r, seen, ...z } });
    }
    return { sheet, news };
  });

  const controls = deps.demoControls;
  if (deps.demo && controls?.rpgSkewHours) {
    const skew = controls.rpgSkewHours;
    app.post('/api/demo/rpg-clock', async (req, reply) => {
      skew(int(asObject(req.body).hours, 'hours', { min: 0, max: 24 * 400 }));
      return reply.code(204).send();
    });
  }
}
