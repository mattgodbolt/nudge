// The offline eval's owner profile and Anthropic key. A module of its own so tests can import it without running the eval's command line.
import Database from 'better-sqlite3';
import { ownerProfileComplete, type OwnerProfile } from '../../shared/owner.js';

/**
 * The owner's profile for the prompt: from `--owner-name`/`--owner-about`, else from the settings row of the database
 * copy named by `--db` (opened read-only). Throws a clear message when there is none: the prompt is never built
 * for nobody in particular.
 */
export function evalOwner(argv: { arg: (n: string) => string | undefined }): OwnerProfile {
  const name = argv.arg('owner-name');
  const about = argv.arg('owner-about');
  let owner: OwnerProfile = { name: name ?? '', about: about ?? '' };
  const dbPath = argv.arg('db');
  if (dbPath && (!name || !about)) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'owner'").get() as { value: string } | undefined;
      const stored = row ? (JSON.parse(row.value) as Partial<OwnerProfile>) : {};
      owner = {
        name: name ?? (typeof stored.name === 'string' ? stored.name : ''),
        about: about ?? (typeof stored.about === 'string' ? stored.about : ''),
      };
    } finally {
      db.close();
    }
  }
  if (!ownerProfileComplete(owner)) {
    throw new Error(
      "No owner profile: the classifier's prompt is built from it. Pass --db <copy of nudge.db> whose Settings > " +
        'About you is filled in, or --owner-name "..." --owner-about "...".',
    );
  }
  return owner;
}

/**
 * The Anthropic key for `run`: ANTHROPIC_API_KEY, else the key stored in Settings in the database copy named by
 * `--db` (opened read-only). There is no key file: a separate key with a small spend limit goes in the variable.
 */
export function evalApiKey(env: NodeJS.ProcessEnv, argv: { arg: (n: string) => string | undefined }): string {
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const dbPath = argv.arg('db');
  if (dbPath) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'llm'").get() as { value: string } | undefined;
      const stored = row ? (JSON.parse(row.value) as { apiKey?: unknown }).apiKey : undefined;
      if (typeof stored === 'string' && stored.trim()) return stored.trim();
    } finally {
      db.close();
    }
  }
  throw new Error(
    'No Anthropic key: set ANTHROPIC_API_KEY, or pass --db <copy of nudge.db> whose Settings > Assistant: ' +
      'Anthropic API key is filled in.',
  );
}
