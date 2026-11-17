/**
 * Per-browser preferences in localStorage. Storage can be missing or throw (private mode, blocked site data, SSR),
 * so every access is guarded: reads fall back, writes are dropped and the choice lasts until the page reloads.
 * The optional `storage` argument is for tests; null means "no storage".
 */
type Reader = Pick<Storage, 'getItem'> | null;
type Writer = Pick<Storage, 'setItem'> | null;

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored string, or null when absent or storage is unavailable. */
export function loadRaw(key: string, storage: Reader = browserStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function saveRaw(key: string, value: string, storage: Writer = browserStorage()): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** A JSON value; the fallback when absent, unparseable or storage is unavailable. */
export function load<T>(key: string, fallback: T): T {
  const v = loadRaw(key);
  if (v === null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  saveRaw(key, JSON.stringify(value));
}
