/**
 * Which build of the web app a page is running, and whether the server has moved on. The build is named by the hashed
 * entry script in index.html (e.g. /assets/index-AbC123.js): it changes whenever any code does, and it is exactly what a
 * stale tab or installed app is still running. The server tells every open page its own (in the event stream's ping),
 * and the page compares it with the script it loaded.
 */

/** The hashed entry script named in an index.html, e.g. /assets/index-AbC123.js (absent in dev). */
export function entryScript(html: string): string | null {
  return /<script[^>]+src="(\/assets\/index-[\w-]+\.js)"/.exec(html)?.[1] ?? null;
}

/**
 * True when the server is serving a different build than the page loaded. Unknown on either side (a dev server, a page
 * without a hashed script, a server with no built UI) is never "different": nothing to compare, so nothing to say.
 */
export function buildChanged(served: string | null | undefined, loaded: string | null | undefined): boolean {
  return !!served && !!loaded && served !== loaded;
}

/** The body of the event stream's `ping` event. `build` is null when the server has no built UI to name. */
export interface PingPayload {
  build: string | null;
}

/** Read a ping's data defensively: the older server sent a bare `1`, and nothing here may throw. */
export function parsePing(data: unknown): PingPayload {
  try {
    const v = typeof data === 'string' ? JSON.parse(data) : data;
    const build = v && typeof v === 'object' ? (v as { build?: unknown }).build : null;
    return { build: typeof build === 'string' && build.length > 0 && build.length <= 200 ? build : null };
  } catch {
    return { build: null };
  }
}
