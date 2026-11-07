import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    // Tests that create real SQLite files can take many seconds on slow storage (e.g. Docker on ZFS) under load.
    testTimeout: 30_000,
    projects: [
      {
        extends: false,
        test: { name: 'server', environment: 'node', include: ['server/**/*.test.ts', 'shared/**/*.test.ts'] },
      },
      {
        extends: true,
        resolve: { conditions: ['browser'] },
        test: { name: 'web', environment: 'jsdom', include: ['web/**/*.test.ts'] },
      },
    ],
  },
});
