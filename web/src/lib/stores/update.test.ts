import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMIND_AFTER_MS, loadedBuild, update, updatePromptVisible } from './update.svelte';

const OLD = '/assets/index-old.js';
const NEW = '/assets/index-new.js';

describe('updatePromptVisible', () => {
  it('shows only when the server is serving a different build', () => {
    expect(updatePromptVisible(NEW, OLD, null, 0)).toBe(true);
    expect(updatePromptVisible(OLD, OLD, null, 0)).toBe(false);
    expect(updatePromptVisible(null, OLD, null, 0)).toBe(false); // server has no built UI
    expect(updatePromptVisible(NEW, null, null, 0)).toBe(false); // a dev page
  });
  it('stays quiet after "not now" until the reminder time has passed', () => {
    expect(updatePromptVisible(NEW, OLD, 1_000, 1_000 + REMIND_AFTER_MS - 1)).toBe(false);
    expect(updatePromptVisible(NEW, OLD, 1_000, 1_000 + REMIND_AFTER_MS)).toBe(true);
  });
});

describe('update store', () => {
  beforeEach(() => update.reset(OLD));
  it('shows on the first ping naming a new build, and hides again if the server goes back', () => {
    update.noteServerBuild(OLD, 0);
    expect(update.visible).toBe(false);
    update.noteServerBuild(NEW, 1);
    expect(update.visible).toBe(true);
    update.noteServerBuild(OLD, 2);
    expect(update.visible).toBe(false);
  });
  it('is put off by dismiss, returns on the next ping after the delay, and never reloads by itself', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    update.noteServerBuild(NEW, 0);
    update.dismiss(10);
    expect(update.visible).toBe(false);
    update.noteServerBuild(NEW, 20); // pings keep coming: still quiet
    expect(update.visible).toBe(false);
    update.noteServerBuild(NEW, 10 + REMIND_AFTER_MS);
    expect(update.visible).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    update.reload();
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('loadedBuild', () => {
  it('reads the entry script from the document, and is null without one', () => {
    const doc = (src?: string) =>
      ({
        querySelector: () => (src ? { getAttribute: () => src } : null),
      }) as unknown as Document;
    expect(loadedBuild(doc(OLD))).toBe(OLD);
    expect(loadedBuild(doc())).toBeNull();
    expect(loadedBuild(undefined)).toBeNull();
  });
});
