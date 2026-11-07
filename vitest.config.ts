import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Tests that create real SQLite files can take many seconds on slow storage (e.g. Docker on ZFS) under load. Set per
// project: the server project has `extends: false`, so a top-level testTimeout would not reach it.
const SLOW_IO_TIMEOUT = 30_000;

export default defineConfig({
  plugins: [svelte()],
  test: {
    projects: [
      {
        extends: false,
        test: {
          name: 'server',
          environment: 'node',
          testTimeout: SLOW_IO_TIMEOUT,
          include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
        },
      },
      {
        extends: true,
        resolve: { conditions: ['browser'] },
        test: { name: 'web', environment: 'jsdom', testTimeout: SLOW_IO_TIMEOUT, include: ['web/**/*.test.ts'] },
      },
    ],
  },
});
