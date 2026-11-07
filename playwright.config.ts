import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:4518', permissions: ['clipboard-read', 'clipboard-write'] },
  webServer: {
    command: 'npm run demo:e2e',
    url: 'http://127.0.0.1:4518/api/bootstrap',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
