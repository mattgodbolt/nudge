import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drafts } from './drafts.svelte';
import { toasts } from './toasts.svelte';

describe('drafts', () => {
  let ok: boolean;
  beforeEach(() => {
    ok = false;
    toasts.items = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ok
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ error: 'disk full', code: 'internal' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const errors = () => toasts.items.filter((t) => t.kind === 'error');

  it('says so when a draft cannot be saved (once, not on every keystroke), and again after it recovers', async () => {
    drafts.set('c1', 'half a reply');
    await drafts.flush('c1');
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.message).toMatch(/draft/i);
    drafts.set('c1', 'half a reply, more');
    await drafts.flush('c1');
    expect(errors()).toHaveLength(1);
    ok = true;
    await drafts.flush('c1');
    ok = false;
    await drafts.flush('c1');
    expect(errors()).toHaveLength(2);
    expect(drafts.bodies.c1).toBe('half a reply, more');
  });
});
