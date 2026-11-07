export { YtError } from '../contracts.js';
export type { YtErrorReason } from '../contracts.js';
import { YtError, type YtErrorReason } from '../contracts.js';

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

interface ApiErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] };
}

/** True for transient failures worth retrying (5xx, 429, per-second rate limits). */
export function isRetryable(status: number, body: unknown): boolean {
  if (status >= 500 || status === 429) return true;
  const reason = (body as ApiErrorBody | null)?.error?.errors?.[0]?.reason;
  return !!reason && RATE_LIMIT_REASONS.has(reason);
}

/** Map a Google API error response onto our small set of reasons. */
export function mapApiError(status: number, body: unknown): YtError {
  const err = (body as ApiErrorBody | null)?.error;
  const reason = err?.errors?.[0]?.reason ?? '';
  const message = err?.message ?? `HTTP ${status}`;
  let mapped: YtErrorReason;
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') mapped = 'quotaExceeded';
  else if (reason === 'commentsDisabled') mapped = 'commentsDisabled';
  else if (/NotFound$/.test(reason) || reason === 'notFound' || status === 404) mapped = 'notFound';
  else if (
    reason === 'keyInvalid' ||
    reason === 'keyExpired' ||
    reason === 'accessNotConfigured' ||
    /api key (not valid|expired)/i.test(message)
  )
    mapped = 'keyInvalid';
  else if (reason === 'forbidden' || reason === 'insufficientPermissions' || status === 403) mapped = 'forbidden';
  else if (status === 400) mapped = 'badRequest';
  else mapped = 'unknown';
  return new YtError(mapped, message, status);
}
