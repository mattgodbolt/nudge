import type { FastifyReply } from 'fastify';
import { OWNER_PROFILE_MISSING } from '../../shared/owner.js';
import type { SettingsDTO } from '../../shared/types.js';
import type { AppDeps } from '../contracts.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = 'bad_request',
  ) {
    super(message);
  }
}

/**
 * Where work a route starts but does not wait for (snooze context, bucketing, a best-effort GitHub fetch) reports a
 * failure. Not `req.log`: the app runs Fastify with its logger off, so that would say nothing at all.
 */
export const logBackground = (msg: string, err?: unknown): void =>
  console.warn(msg, err instanceof Error ? err.message : (err ?? ''));

/**
 * The answer of a route that would call the model while Settings > About you is incomplete (409). The prompts are built
 * from the profile, so the model is never asked without it.
 */
export function ownerProfileMissing(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({ ...OWNER_PROFILE_MISSING, code: OWNER_PROFILE_MISSING.error });
}

export const bad = (message: string) => new HttpError(400, message, 'bad_request');
export const notFound = (what: string) => new HttpError(404, `${what} not found`, 'not_found');

export function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Expected a JSON object body');
  return body as Record<string, unknown>;
}

export function str(o: Record<string, unknown>, key: string, opts: { optional?: boolean; allowEmpty?: boolean } = {}) {
  const v = o[key];
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== 'string') throw bad(`"${key}" must be a string`);
  if (!opts.allowEmpty && v.trim() === '') throw bad(`"${key}" must not be empty`);
  return v;
}

export function bool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw bad(`"${key}" must be a boolean`);
  return v;
}

export function int(
  v: unknown,
  name: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw bad(`"${name}" must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw bad(`"${name}" must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

export function buildSettingsDto(deps: AppDeps): SettingsDTO {
  const s = deps.repo.getSettings();
  const { key, source } = deps.resolveApiKey();
  const channels = deps.repo.listSources().filter((x) => x.kind === 'channel');
  return {
    apiKey: { configured: key !== null, source, last4: key ? key.slice(-4) : null },
    ownChannelIds: s.ownChannelIds,
    ownChannels: s.ownChannelIds.map((id) => {
      const src = channels.find((c) => c.ytId === id);
      return { id, title: src?.title ?? null, thumbnailUrl: src?.thumbnailUrl ?? null };
    }),
    pollEnabled: s.pollEnabled,
    dailyQuotaBudget: s.dailyQuotaBudget,
    manualReserve: s.manualReserve,
    backfillDays: s.backfillDays,
    theme: s.theme,
    snoozeDays: s.snoozeDays,
    demo: deps.demo,
    version: deps.version ?? 'dev',
    github: {
      configured: s.github.token !== null,
      last4: s.github.token ? s.github.token.slice(-4) : null,
      myAccounts: s.github.myAccounts,
    },
    llm: {
      configured: s.llm.apiKey !== null,
      last4: s.llm.apiKey ? s.llm.apiKey.slice(-4) : null,
      model: s.llm.model,
    },
    owner: { ...s.owner },
    // Status only: account titles and flags. Tokens and the client secret never leave the server.
    google: deps.auth.status(),
    rpg: { enabled: s.rpg.enabled, sound: s.rpg.sound, title: s.rpg.title },
  };
}
