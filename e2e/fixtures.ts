import { test as base } from '@playwright/test';

export * from '@playwright/test';

/**
 * Every spec fails if the page breaks the Content-Security-Policy (server/headers.ts). The browser only reports a
 * violation on the console, and a blocked style or font fails silently otherwise, so this is the one place a policy too
 * tight for the real app shows up. Two reports are not the app's:
 * - Chrome reports an inline handler when DOMPurify merely parses one (in an inert DOMParser document, where it could
 *   never run; the demo's GitHub threads carry an `onerror` on purpose). So those reports are ignored, and instead any
 *   on* attribute that reaches the live page fails the test.
 * - Playwright's trace recorder fetches images from inside the page, which connect-src refuses; those come with no
 *   source location, while every report caused by the app names the page or script it came from.
 */
export const test = base.extend<{ cspGuard: void }>({
  cspGuard: [
    async ({ context }, use) => {
      const violations: string[] = [];
      await context.addInitScript(() => {
        const check = (el: Element) => {
          for (const a of el.attributes) {
            if (a.name.startsWith('on')) console.error(`CSP guard: inline handler ${a.name} on <${el.localName}>`);
          }
        };
        new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === 'attributes') check(r.target as Element);
            for (const n of r.addedNodes) {
              if (n instanceof Element) [n, ...n.querySelectorAll('*')].forEach(check);
            }
          }
        }).observe(document, { childList: true, subtree: true, attributes: true });
      });
      context.on('console', (m) => {
        const text = m.text();
        if (text.startsWith('CSP guard:')) violations.push(text);
        else if (/Content Security Policy/i.test(text) && !/inline event handler/i.test(text) && m.location().url) {
          violations.push(`${m.location().url}: ${text.slice(0, 300)}`);
        }
      });
      await use();
      if (violations.length) throw new Error(`Content-Security-Policy violations:\n${violations.join('\n')}`);
    },
    { auto: true },
  ],
});
