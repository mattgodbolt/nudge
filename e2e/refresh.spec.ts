import { expect, test, type CDPSession, type Page } from '@playwright/test';

// Resync from a stale tab: a button, Shift+R, coming back to the tab, and (on touch) pulling the list down.

const isBootstrap = (r: { url(): string }) => new URL(r.url()).pathname === '/api/bootstrap';

test.beforeEach(async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
});

test('the Refresh button refetches bootstrap and the list', async ({ page }) => {
  const boot = page.waitForResponse(isBootstrap);
  const list = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/inbox');
  await page.getByTestId('refresh').click();
  await Promise.all([boot, list]);
  await expect(page.getByTestId('refresh')).toBeEnabled();
});

test('Shift+R does the same', async ({ page }) => {
  const boot = page.waitForResponse(isBootstrap);
  await page.keyboard.press('Shift+R');
  await boot;
});

test('coming back to a tab that was away resyncs it, but a quick glance does not', async ({ page }) => {
  const hide = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  let boots = 0;
  page.on('request', (r) => isBootstrap(r) && boots++);

  await hide(true);
  await hide(false);
  await page.waitForTimeout(400);
  expect(boots).toBe(0);

  await hide(true);
  // Pretend the tab was away for a minute.
  await page.evaluate(() => {
    const real = Date.now;
    Date.now = () => real() + 60_000;
  });
  const boot = page.waitForResponse(isBootstrap);
  await hide(false);
  await boot;
});

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 412, height: 800 }, hasTouch: true, isMobile: true });

  async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', y = 0) {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: 200, y }],
    });
  }
  const pullDown = async (page: Page, cdp: CDPSession, from: number, to: number) => {
    await touch(cdp, 'touchStart', from);
    for (let y = from; y <= to; y += 12) await touch(cdp, 'touchMove', y);
    await touch(cdp, 'touchEnd');
  };

  test('pulling the list down from the top refreshes; a short pull does not', async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid=inbox-row]');
    const cdp = await page.context().newCDPSession(page);
    const box = (await page.getByRole('listbox', { name: 'Comments' }).boundingBox())!;
    const from = box.y + 40;

    let boots = 0;
    page.on('request', (r) => isBootstrap(r) && boots++);

    await pullDown(page, cdp, from, from + 50);
    await page.waitForTimeout(400);
    expect(boots).toBe(0);

    const boot = page.waitForResponse(isBootstrap);
    await pullDown(page, cdp, from, from + 260);
    await boot;
    await expect(page.getByTestId('pull-indicator')).toHaveCSS('opacity', '0');
  });

  test('a pull still completes when a live update removes the touched row mid-gesture', async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid=inbox-row]');
    const cdp = await page.context().newCDPSession(page);
    const box = (await page.getByRole('listbox', { name: 'Comments' }).boundingBox())!;
    const from = box.y + 40;

    await touch(cdp, 'touchStart', from);
    await touch(cdp, 'touchMove', from + 20);
    // What an SSE update does when it drops the row under the finger: the touch target leaves the document.
    await page.evaluate((y) => document.elementFromPoint(200, y)?.closest('[data-testid=inbox-row]')?.remove(), from);
    const boot = page.waitForResponse(isBootstrap);
    for (let y = from + 20; y <= from + 260; y += 12) await touch(cdp, 'touchMove', y);
    await touch(cdp, 'touchEnd');
    await boot;
  });

  test('the Refresh button is a full-size tap target in the header', async ({ page }) => {
    await page.goto('/inbox');
    const box = (await page.getByTestId('refresh').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const boot = page.waitForResponse(isBootstrap);
    await page.getByTestId('refresh').tap();
    await boot;
  });
});
