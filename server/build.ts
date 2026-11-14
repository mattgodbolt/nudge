import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { entryScript } from '../shared/build.js';

/**
 * The id of the web build this server is serving: the hashed entry script named by the index.html on disk. Read from
 * the file rather than remembered at start-up, so it is always what a page that loads `/` right now would get; the
 * file is only re-read when its modification time changes. `override` (demo servers and tests) names a build that
 * does not exist, so a page can be shown the "new version" prompt without a second build.
 */
export function createBuildId(staticDir: string | undefined, override?: string | null): () => string | null {
  if (override) return () => override;
  if (!staticDir) return () => null;
  const file = join(staticDir, 'index.html');
  let seen = -1;
  let id: string | null = null;
  return () => {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime !== seen) {
        id = entryScript(readFileSync(file, 'utf8'));
        seen = mtime;
      }
    } catch {
      id = null;
      seen = -1;
    }
    return id;
  };
}
