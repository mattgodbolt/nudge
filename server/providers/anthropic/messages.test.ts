import { describe, expect, it } from 'vitest';
import { LlmError } from '../../contracts.js';
import { postMessages, tokensOf, toolChoice } from './messages.js';

const capture = (status: number, body: unknown) => {
  const calls: { url: unknown; init: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
};

describe('postMessages', () => {
  it('sends the same URL, headers and body on every call', async () => {
    const { calls, fetchImpl } = capture(200, { ok: 1 });
    expect(await postMessages(fetchImpl, 'k', { model: 'm', max_tokens: 8 }, 1000)).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
    expect(calls[0]!.init.body).toBe('{"model":"m","max_tokens":8}');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
  it('maps a non-2xx status and a network failure to LlmError', async () => {
    const { fetchImpl } = capture(429, { error: { message: 'slow down' } });
    await expect(postMessages(fetchImpl, 'k', {}, 1000)).rejects.toMatchObject({
      message: 'Anthropic said 429: slow down',
      status: 429,
    });
    const down = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(postMessages(down, 'k', {}, 1000)).rejects.toThrow(new LlmError('Could not reach Anthropic: boom'));
  });
});

describe('tokensOf and toolChoice', () => {
  it('rounds good counts and zeroes bad ones', () => {
    expect(tokensOf({ usage: { input_tokens: 10.4, cache_read_input_tokens: -1, output_tokens: 'x' } })).toEqual({
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(tokensOf({}).inputTokens).toBe(0);
  });
  it('forces the tool only for haiku', () => {
    expect(toolChoice('claude-haiku-4', 't')).toEqual({ type: 'tool', name: 't' });
    expect(toolChoice('claude-sonnet-5', 't')).toEqual({ type: 'auto' });
  });
});
