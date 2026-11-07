import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
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
