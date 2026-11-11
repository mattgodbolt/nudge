import type { FastifyInstance } from 'fastify';
import {
  ITEM_EVENT_INPUTS,
  ITEM_EVENT_KINDS,
  MAX_ITEM_EVENTS_PER_REQUEST,
  type ClientItemEventKind,
  type ItemEventsPostResult,
} from '../../shared/api.js';
import type { NewItemEvent } from '../db/events.js';
import type { AppDeps } from '../contracts.js';
import { asObject, bad } from './util.js';

const DAY_MS = 24 * 3_600_000;
const MAX_STR = 200;
const MAX_ABOVE = 10;
const MAX_COUNT = 1_000_000;
const MAX_DWELL_MS = 3_600_000;

const isStr = (v: unknown, max = MAX_STR): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Keep only the allow-listed, correctly typed meta keys; anything else is dropped rather than stored. */
function cleanMeta(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const m = raw as Record<string, unknown>;
  if (isStr(m.view, 64)) out.view = m.view;
  if (m.rank === null || isNum(m.rank, 0, MAX_COUNT)) out.rank = m.rank === null ? null : Math.floor(m.rank as number);
  if (isNum(m.listSize, 0, MAX_COUNT)) out.listSize = Math.floor(m.listSize);
  if (isNum(m.selectionSize, 0, MAX_COUNT)) out.selectionSize = Math.floor(m.selectionSize);
  if (Array.isArray(m.above)) out.above = m.above.filter((x): x is string => isStr(x)).slice(0, MAX_ABOVE);
  if (typeof m.input === 'string' && (ITEM_EVENT_INPUTS as readonly string[]).includes(m.input)) out.input = m.input;
  if (typeof m.bulk === 'boolean') out.bulk = m.bulk;
  if (isNum(m.dwellMs, 0, MAX_DWELL_MS)) out.dwellMs = Math.round(m.dwellMs);
  return out;
}

/**
 * Browser-reported decision/open events for learning the owner's triage habits. Stays in the local database; host,
 * Origin and client header checks apply to every route via registerSecurity.
 */
export function registerItemEventRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { clientEvents } = deps.repo;

  app.post('/api/item-events', async (req): Promise<ItemEventsPostResult> => {
    const b = asObject(req.body);
    if (!Array.isArray(b.events)) throw bad('"events" must be an array');
    if (b.events.length > MAX_ITEM_EVENTS_PER_REQUEST)
      throw bad(`At most ${MAX_ITEM_EVENTS_PER_REQUEST} events per request`);

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const valid: NewItemEvent[] = [];
    let rejected = 0;
    for (const raw of b.events as unknown[]) {
      const e =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      if (!e || !(ITEM_EVENT_KINDS as readonly unknown[]).includes(e.kind) || !isStr(e.itemId)) {
        rejected++;
        continue;
      }
      let at = now;
      if (typeof e.at === 'string') {
        const t = Date.parse(e.at);
        if (Number.isFinite(t) && t <= nowMs && t >= nowMs - DAY_MS) at = new Date(t).toISOString();
      }
      valid.push({
        itemId: e.itemId,
        at,
        kind: e.kind as ClientItemEventKind,
        from: null,
        to: isStr(e.to, 64) ? e.to : null,
        source: 'user',
        meta: cleanMeta(e.meta),
      });
    }
    const { accepted, unknown } = clientEvents.record(valid);
    return { accepted, rejected: rejected + unknown };
  });
}
