import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '../../../../shared/types';

const dto = (over: { demo?: boolean; apiKey?: { configured: boolean } }) =>
  ({ demo: false, apiKey: { configured: false }, ...over }) as unknown as SettingsDTO;

describe('needsKey', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('asks for a YouTube key on a real instance without one', async () => {
    const { settings } = await import('./settings.svelte');
    settings.value = dto({});
    expect(settings.needsKey).toBe(true);
  });

  it('does not ask once there is a key, or in demo mode', async () => {
    const { settings } = await import('./settings.svelte');
    settings.value = dto({ apiKey: { configured: true } });
    expect(settings.needsKey).toBe(false);
    settings.value = dto({ demo: true });
    expect(settings.needsKey).toBe(false);
  });

  it('lets a GitHub-only or todos-only owner skip it, and remembers that in this browser', async () => {
    let { settings } = await import('./settings.svelte');
    settings.value = dto({});
    settings.skipYoutube();
    expect(settings.needsKey).toBe(false);

    vi.resetModules();
    ({ settings } = await import('./settings.svelte'));
    settings.value = dto({});
    expect(settings.needsKey).toBe(false);
  });
});
