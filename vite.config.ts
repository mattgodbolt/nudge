import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Short commit SHA baked into the page, so Settings can show which build a (possibly stale) tab is running.
function buildVersion(): string {
  const fromEnv = process.env.GIT_SHA?.trim();
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

const API = `http://127.0.0.1:${process.env.NUDGE_PORT ?? 4517}`;

export default defineConfig({
  root: 'web',
  define: { __BUILD_VERSION__: JSON.stringify(buildVersion()) },
  plugins: [svelte()],
  // NUDGE_WEB_DIR (relative to the repo root) lets a second e2e run build somewhere of its own.
  build: { outDir: process.env.NUDGE_WEB_DIR ? `../${process.env.NUDGE_WEB_DIR}` : '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: API, changeOrigin: true } } },
});
