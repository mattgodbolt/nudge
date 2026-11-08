import { execFileSync } from 'node:child_process';

/**
 * The commit this server is running. Docker builds have no .git (it is dockerignored), so the image carries it in
 * GIT_SHA; a dev checkout asks git; anything else is just "dev".
 */
export function resolveVersion(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GIT_SHA?.trim();
  if (fromEnv) return fromEnv.slice(0, 8);
  try {
    return (
      execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'dev'
    );
  } catch {
    return 'dev';
  }
}
