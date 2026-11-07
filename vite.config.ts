import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const API = `http://127.0.0.1:${process.env.NUDGE_PORT ?? 4517}`;

export default defineConfig({
  root: 'web',
  plugins: [svelte()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: API, changeOrigin: true } } },
});
