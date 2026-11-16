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

test('a resync after a deploy never reloads the page by itself: half-typed text would be lost', async ({ page }) => {
  // The server now serves a newer build than this page loaded.
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/\/assets\/index-[\w-]+\.js/, '/assets/index-e2e-newer.js');
      await route.fulfill({ response: res, body: html });
    },
  );
  await page.evaluate(() => ((window as unknown as { __nudgeLoad?: number }).__nudgeLoad = 1));
  const boot = page.waitForResponse(isBootstrap);
  await page.getByTestId('refresh').click();
  await boot;
  await expect(page.getByTestId('refresh')).toBeEnabled();
  // A reload would have wiped the mark (and anything typed); the "New version available" prompt is the way to it.
  expect(await page.evaluate(() => (window as unknown as { __nudgeLoad?: number }).__nudgeLoad)).toBe(1);
});

test('a broken event stream shows in the sync indicator until it reconnects', async ({ page }) => {
  // Live updates are what keep the list honest; losing them silently meant the first sign was a failed action.
  const events = (url: URL) => url.pathname === '/api/events';
  await page.route(events, (route) => route.abort());
  await page.goto('/inbox');
  const indicator = page.getByTestId('sync-indicator');
  await expect(indicator).toContainText('Reconnecting');
  await page.unroute(events);
  // The browser retries the stream on its own every few seconds.
  await expect(indicator).not.toContainText('Reconnecting', { timeout: 15_000 });
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

test('on a phone the settings page scrolls inside the screen instead of growing past it', async ({ page }) => {
  await page.setViewportSize({ width: 449, height: 900 });
  await page.goto('/settings');
  await expect(page.getByTestId('settings-notifications')).toBeAttached();
  const { scrollable, fits } = await page.evaluate(() => {
    const el = document.querySelector('.page') as HTMLElement;
    return {
      scrollable: el.scrollHeight > el.clientHeight,
      fits: el.getBoundingClientRect().bottom <= window.innerHeight,
    };
  });
  expect(fits).toBe(true);
  expect(scrollable).toBe(true);
});

test('on a phone, an inbox emptied while a thread is open shows the list, not a blank screen', async ({ page }) => {
  await page.setViewportSize({ width: 449, height: 900 });
  await page.goto('/inbox');
  await page.getByTestId('inbox-row').first().click();
  await expect(page.getByTestId('thread-view')).toBeVisible();
  // Everything was actioned elsewhere: the next list load comes back empty.
  await page.route('**/api/inbox?**', (route) => route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }));
  await page.keyboard.press('Shift+R');
  await expect(page.getByTestId('refresh')).toBeVisible();
  await expect(page.getByTestId('thread-view')).toBeHidden();
});

test('the "All caught up" screen has a real Sync now button that starts a sync', async ({ page }) => {
  await page.setViewportSize({ width: 449, height: 900 });
  await page.route('**/api/inbox?**', (route) => route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }));
  await page.goto('/inbox');
  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/sync'));
  await page.getByTestId('empty-sync').click();
  await posted;
});

test.describe('multi-select on a touch phone', () => {
  test.use({ viewport: { width: 412, height: 800 }, hasTouch: true, isMobile: true });

  const press = async (page: Page, row: ReturnType<Page['getByTestId']>, ms: number) => {
    const box = (await row.boundingBox())!;
    const x = box.x + 200;
    const y = box.y + 30;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  test('no tick until a long press; then taps toggle rows and the bar acts on them', async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid=inbox-row]');
    const rows = page.getByTestId('inbox-row');
    await expect(rows.first().getByTestId('row-check')).toBeHidden();

    await press(page, rows.first(), 700);
    await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
    await expect(rows.nth(1).getByTestId('row-check')).toBeVisible();
    await expect(page.locator('.inbox.thread-open')).toHaveCount(0); // the release did not open the item

    await rows.nth(1).tap({ position: { x: 200, y: 30 } });
    await expect(page.getByTestId('bulk-bar')).toContainText('2 selected');
    await rows.nth(1).tap({ position: { x: 200, y: 30 } });
    await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');

    await page.getByTestId('bulk-clear').tap();
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
    await expect(rows.first().getByTestId('row-check')).toBeHidden();
  });

  test('a short tap still opens the item', async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid=inbox-row]');
    await page
      .getByTestId('inbox-row')
      .first()
      .tap({ position: { x: 200, y: 30 } });
    await expect(page.locator('.inbox.thread-open')).toHaveCount(1);
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
  });
});
