import { expect, test } from './fixtures';

// Playwright's browsers run without Web Push (and the sandbox has no push service), so these cover what can be checked
// here: the app is installable-shaped, the service worker registers, and the Settings card is honest about the state.
// Real delivery is verified on a device.

test('serves a valid web app manifest with icons, linked from the page', async ({ page, request }) => {
  await page.goto('/inbox');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const res = await request.get(href!);
  expect(res.headers()['content-type']).toContain('manifest+json');
  const m = await res.json();
  expect(m).toMatchObject({ name: 'Nudge', display: 'standalone', start_url: '/inbox', scope: '/' });
  const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`);
  expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  for (const icon of m.icons) expect((await request.get(icon.src)).status()).toBe(200);
});

test('registers the service worker at the site root', async ({ page }) => {
  await page.goto('/inbox');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('the Notifications card in Settings explains itself and never offers a broken button', async ({ page }) => {
  await page.goto('/settings');
  const card = page.getByTestId('settings-notifications');
  await expect(card).toBeVisible();
  await expect(card).toContainText('this device');
  // Test browsers have notifications blocked (or no Push API): either way the enable button must not be offered
  // while it cannot work.
  await expect(card).toContainText(/blocked|can.t show push notifications/);
  await expect(page.getByTestId('push-on')).toHaveCount(0);
});

test('push API: config is served and bad subscriptions are refused', async ({ request }) => {
  const cfg = await request.get('/api/push/config');
  expect((await cfg.json()).publicKey).toMatch(/^[\w-]{80,}$/);
  const bad = await request.post('/api/push/subscribe', {
    headers: { 'X-Nudge': '1' },
    data: { subscription: { endpoint: 'https://169.254.169.254/x', keys: { p256dh: 'a', auth: 'b' } } },
  });
  expect(bad.status()).toBe(400);
});

test('Settings > About shows the running commit, and the page matches the server', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('about-server')).toHaveText(/^([0-9a-f]{7,8}|dev)$/);
  await expect(page.getByTestId('about-page')).toHaveCount(0);
});
