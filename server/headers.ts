import type { FastifyInstance } from 'fastify';

/**
 * The inline theme script in web/index.html runs before first paint, so it cannot be an external file; it is allowed
 * by hash. headers.test.ts recomputes the hash from the file and fails if this falls behind an edit.
 */
const THEME_SCRIPT_HASH = "'sha256-f5jwM2GjrX0XCR94IAuaG007ZFr+uJke09WMW3wHNk0='";

/** Where avatars and thumbnails come from: YouTube channels and videos, GitHub users, Google accounts. */
const IMAGE_HOSTS = [
  'https://*.ggpht.com',
  'https://i.ytimg.com',
  'https://avatars.githubusercontent.com',
  'https://*.googleusercontent.com',
];

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${THEME_SCRIPT_HASH}`,
  // Svelte renders style="…" attributes (positions in the virtual list, chart bars); <style> elements stay blocked.
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  // Vite inlines the smallest font subsets into the CSS as data: URIs.
  "font-src 'self' data:",
  `img-src 'self' data: ${IMAGE_HOSTS.join(' ')}`,
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Sent on every response (pages, static files, API replies, rejections): cheap, and a page is only as safe as its headers. */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  });
}
