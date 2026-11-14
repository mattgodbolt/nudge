import { expect, test, type Page } from '@playwright/test';

// The "New version available" prompt. Its own demo server (4527) claims a build that is not the one the page loaded
// (NUDGE_DEMO_BUILD_ID), which is exactly what a tab left open across a deploy sees. The server pings its build id as
// soon as the event stream opens, so the prompt appears without waiting out the 20s interval.

const banner = (page: Page) => page.getByTestId('update-banner');

/** Marks this page load, so a reload (which wipes it) is detectable. */
const mark = (page: Page) => page.evaluate(() => ((window as unknown as { __nudgeLoad?: number }).__nudgeLoad = 1));
const marked = (page: Page) => page.evaluate(() => (window as unknown as { __nudgeLoad?: number }).__nudgeLoad === 1);

test.describe('a page that is behind the server', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid=inbox-row]');
  });

  test('shows a quiet prompt and reloads only when told to', async ({ page }) => {
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('New version available');
    await mark(page);
    // Pings keep arriving, but nothing reloads by itself.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    expect(await marked(page)).toBe(true);

    await page.getByTestId('update-reload').click();
    await page.waitForSelector('[data-testid=inbox-row]');
    expect(await marked(page)).toBe(false);
    // Still behind (the demo server insists), so it asks again.
    await expect(banner(page)).toBeVisible();
  });

  test('does not touch what is being typed, and "not now" hides it', async ({ page }) => {
    await expect(banner(page)).toBeVisible();
    await page.keyboard.press('c');
    await page.getByTestId('assistant-input').fill('remind me about the thing');
    await mark(page);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    expect(await marked(page)).toBe(true);
    await expect(page.getByTestId('assistant-input')).toHaveValue('remind me about the thing');
    await page.keyboard.press('Escape');

    await page.getByTestId('update-dismiss').click();
    await expect(banner(page)).toBeHidden();
  });

  test('Esc dismisses it while focus is on the prompt', async ({ page }) => {
    await expect(banner(page)).toBeVisible();
    await page.getByTestId('update-reload').focus();
    await page.keyboard.press('Escape');
    await expect(banner(page)).toBeHidden();
  });
});

for (const [name, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test(`fits and is easy to tap at ${name} width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/inbox');
    await expect(banner(page)).toBeVisible();
    const b = (await banner(page).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
    const reload = (await page.getByTestId('update-reload').boundingBox())!;
    expect(reload.height).toBeGreaterThanOrEqual(name === 'phone' ? 40 : 24);
    expect(reload.x + reload.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
}

// The default demo server serves the build the page loaded, so it must say nothing.
test.describe('a page that is up to date', () => {
  test.use({ baseURL: 'http://127.0.0.1:4518' });

  test('the server names the very script the page loaded, and no prompt appears', async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid=inbox-row]');
    const { loaded, served } = await page.evaluate(
      () =>
        new Promise<{ loaded: string | null; served: string | null }>((resolve) => {
          const es = new EventSource('/api/events');
          es.addEventListener('ping', (e) => {
            es.close();
            resolve({
              loaded: document.querySelector('script[type=module][src*="/assets/index-"]')?.getAttribute('src') ?? null,
              served: JSON.parse((e as MessageEvent).data).build,
            });
          });
        }),
    );
    expect(loaded).toMatch(/^\/assets\/index-[\w-]+\.js$/);
    expect(served).toBe(loaded);
    await expect(banner(page)).toHaveCount(0);
  });
});
