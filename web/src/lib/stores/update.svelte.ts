import { buildChanged } from '../../../../shared/build';

/** After "not now", the prompt returns on the first ping this long afterwards if the page is still out of date. */
export const REMIND_AFTER_MS = 30 * 60_000;

/**
 * Whether to show "New version available". Pure so the policy is testable: the server's build differs from the one
 * this page loaded, and the owner has not just put it off.
 */
export function updatePromptVisible(
  served: string | null,
  loaded: string | null,
  dismissedAt: number | null,
  now: number,
): boolean {
  if (!buildChanged(served, loaded)) return false;
  return dismissedAt === null || now - dismissedAt >= REMIND_AFTER_MS;
}

/** The hashed entry script this page was loaded from; null in dev, where there is nothing to compare. */
export function loadedBuild(doc: Document | undefined = typeof document === 'undefined' ? undefined : document) {
  return (
    doc?.querySelector<HTMLScriptElement>('script[type=module][src*="/assets/index-"]')?.getAttribute('src') ?? null
  );
}

/**
 * Tells the page when it has been left running across a deploy. It only ever shows a prompt: reloading discards
 * whatever is half-typed (a note, a snooze reason, a message to the assistant), so that happens on a click and never
 * by itself. The event stream's ping carries the server's build; each one is checked here.
 */
class UpdateStore {
  /** The build this page is running, fixed when it loaded. */
  loaded: string | null = loadedBuild();
  /** The build the server last said it is serving. */
  served = $state<string | null>(null);
  #dismissedAt: number | null = null;
  visible = $state(false);

  /** A ping arrived naming the server's build. */
  noteServerBuild(build: string | null, now = Date.now()): void {
    this.served = build;
    this.visible = updatePromptVisible(build, this.loaded, this.#dismissedAt, now);
  }

  /** Not now: hide it until a ping after REMIND_AFTER_MS finds the page still out of date. */
  dismiss(now = Date.now()): void {
    this.#dismissedAt = now;
    this.visible = false;
  }

  reload(): void {
    location.reload();
  }

  /** Test helper. */
  reset(loaded: string | null = null): void {
    this.loaded = loaded;
    this.served = null;
    this.#dismissedAt = null;
    this.visible = false;
  }
}

export const update = new UpdateStore();
