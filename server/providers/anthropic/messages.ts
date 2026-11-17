import { LlmError } from '../../contracts.js';
import type { LlmTokens } from '../../contracts.js';

/** The one place that knows how to talk to the Anthropic Messages API; the classifier, snooze AI and assistant share it. */
export const API = 'https://api.anthropic.com/v1/messages';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** For a value inside an attribute's double quotes: also escapes the quotes, so the value cannot end the attribute. */
export const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** One POST, already-serialised body, no interpretation of the outcome: a network failure rejects, any status resolves. */
export function sendMessages(
  doFetch: typeof fetch,
  apiKey: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  return doFetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** One attempt: the parsed reply, or an LlmError for a network failure or a non-2xx status. */
export async function postMessages(
  doFetch: typeof fetch,
  apiKey: string,
  body: Json,
  timeoutMs: number,
): Promise<Json> {
  let res: Response;
  try {
    res = await sendMessages(doFetch, apiKey, JSON.stringify(body), timeoutMs);
  } catch (e) {
    throw new LlmError(`Could not reach Anthropic: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const detail = typeof json?.error?.message === 'string' ? `: ${json.error.message}` : '';
    throw new LlmError(`Anthropic said ${res.status}${detail}`, res.status);
  }
  return json;
}

/** Token usage from a reply, each count a non-negative integer (anything else is 0). */
export const tokensOf = (json: Json): LlmTokens => {
  const u: Json = json.usage && typeof json.usage === 'object' ? json.usage : {};
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    inputTokens: n(u.input_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
    outputTokens: n(u.output_tokens),
  };
};

/** Not every model accepts a forced tool, so only haiku is forced; the schema and prompt still leave the tool as the way out. */
export const toolChoice = (model: string, name: string): { type: 'tool'; name: string } | { type: 'auto' } =>
  model.includes('haiku') ? { type: 'tool', name } : { type: 'auto' };
