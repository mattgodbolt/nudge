import { expect, test, type APIRequestContext, type Page } from './fixtures';

// A demo server with a 300-item backlog on top of the usual GitHub items, comment threads, the fake suggestion source,
// and a daily cap that bites after 1,100 suggestions (NUDGE_DEMO_BACKLOG / NUDGE_DEMO_SUGGEST_CAP_AFTER). So the worker
// works through the backlog in passes, runs into the cap, and stays paused: a stable state to look at. The tests
// change shared state at the end (bulk Done), so they run in order.
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.NUDGE_SHOTS;
const H = { 'x-nudge': '1' };
const rows = (page: Page) => page.getByTestId('inbox-row');
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

interface Status {
  enabled: boolean;
  total: number;
  done: number;
  working: boolean;
  paused: { reason: string; until: string | null } | null;
}
const status = async (request: APIRequestContext): Promise<Status> =>
  (await request.get('/api/suggestions/status', { headers: H })).json();
const inboxPage = async (request: APIRequestContext, q: string) =>
  (await request.get(`/api/inbox?view=inbox&${q}`, { headers: H })).json() as Promise<{
    total: number;
    items: { item: { title: string | null }; comment: { id: string } }[];
  }>;

/** Wait until the worker has worked through what it may and stopped at the cap. */
async function settled(request: APIRequestContext): Promise<Status> {
  await expect
    .poll(async () => (await status(request)).paused?.reason, { timeout: 60_000, intervals: [250] })
    .toBe('cap');
  await expect.poll(async () => (await status(request)).working, { timeout: 10_000 }).toBe(false);
  return status(request);
}

const fmt = (n: number) => n.toLocaleString('en-US');
const lineRe = /^Suggestions: [\d,]+ of [\d,]+ done, paused until the daily limit resets \(00:00 UTC\)$/;

test('works through the backlog in passes until the daily cap, and says how far it got', async ({ request, page }) => {
  const st = await settled(request);
  // The demo's own comments on YouTube, plus the 330 GitHub items.
  expect(st.total).toBeGreaterThan(1000);
  // The cap bit after 1,100 model calls (rules cost nothing, so a few more are done); the rest wait.
  expect(st.done).toBeGreaterThanOrEqual(1100);
  expect(st.done).toBeLessThan(st.total);

  await page.goto('/settings');
  const line = page.getByTestId('suggest-progress');
  await expect(line).toHaveText(lineRe);
  await expect(line).toContainText(`${fmt(st.done)} of ${fmt(st.total)} done`);
  await line.scrollIntoViewIfNeeded();
  await shot(page, 'settings-progress-desktop');

  await page.goto('/sources');
  await expect(page.getByTestId('suggest-progress')).toHaveText(lineRe);
});

test('the inbox can be filtered by suggestion, and the choice lives in the URL', async ({ request, page }) => {
  const st = await settled(request);
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
  const filter = page.getByTestId('sug-filter');
  await expect(filter).toHaveValue('');

  await filter.selectOption('none');
  await expect(page).toHaveURL(/sug=none/);
  await expect(page.locator('header .count')).toHaveText(`${fmt(st.total - st.done)} items`);
  await expect(page.getByTestId('row-suggestion')).toHaveCount(0);

  await filter.selectOption('me');
  await expect(page).toHaveURL(/sug=me/);
  const yours = (await inboxPage(request, 'suggestion=me')).total;
  expect(yours).toBeGreaterThan(10);
  await expect(page.locator('header .count')).toHaveText(`${fmt(yours)} items`);
  await expect(rows(page).first()).toBeVisible();
  const texts = await page.getByTestId('row-suggestion').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  expect(texts.length).toBeGreaterThan(3);
  expect(texts.every((t) => t.startsWith('your turn'))).toBe(true);
  await shot(page, 'inbox-filter-desktop');

  // It survives a reload (it is the URL), and "any" clears it.
  await page.reload();
  await expect(page.getByTestId('sug-filter')).toHaveValue('me');
  await expect(rows(page).first()).toBeVisible();
  await page.getByTestId('sug-filter').selectOption('them');
  await expect
    .poll(async () =>
      (await page.getByTestId('row-suggestion').evaluateAll((els) => els.map((e) => e.textContent ?? ''))).every((t) =>
        t.startsWith('waiting on them'),
      ),
    )
    .toBe(true);
  await page.getByTestId('sug-filter').selectOption('');
  await expect(page).not.toHaveURL(/sug=/);
  await expect(page.locator('header .count')).toHaveText(`${fmt(st.total)} items`);
});

test('oldest first works together with the filter', async ({ request, page }) => {
  await settled(request);
  const newest = await inboxPage(request, 'suggestion=act&order=newest&limit=3');
  const oldest = await inboxPage(request, 'suggestion=act&order=oldest&limit=3');
  expect(oldest.total).toBe(newest.total);
  expect(oldest.items[0]!.item.title).not.toBe(newest.items[0]!.item.title);

  await page.goto('/inbox?sug=act');
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).first().getByTestId('row-title')).toHaveText(newest.items[0]!.item.title!);
  await page.getByTestId('sort').selectOption('oldest');
  await expect(rows(page).first().getByTestId('row-title')).toHaveText(oldest.items[0]!.item.title!);
  await expect(page.getByTestId('sug-filter')).toHaveValue('act');
  await page.getByTestId('sort').selectOption('newest');
  await expect(rows(page).first().getByTestId('row-title')).toHaveText(newest.items[0]!.item.title!);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the suggestion filter shares the one scrolling filter line, and nothing overflows', async ({
    request,
    page,
  }) => {
    await settled(request);
    await page.goto('/inbox');
    await expect(rows(page).first()).toBeVisible();
    const filters = (await page.getByTestId('gh-filters').boundingBox())!;
    expect(filters.height).toBeLessThan(64);
    const who = (await page.getByTestId('who-all').boundingBox())!;
    const sel = (await page.getByTestId('sug-filter').boundingBox())!;
    expect(Math.abs(who.y - sel.y)).toBeLessThan(6);
    expect(sel.height).toBeGreaterThanOrEqual(40);
    // Nothing in the list pane pokes out of the screen (the filter line scrolls inside its own box).
    const fits = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid=gh-filters], [data-testid=inbox-row], .list')].every(
          (el) => el.getBoundingClientRect().right <= 390.5,
        ),
      );
    expect(await fits()).toBe(true);

    await page.getByTestId('sug-filter').selectOption('them');
    await expect(page).toHaveURL(/sug=them/);
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByTestId('row-suggestion').first()).toContainText('waiting on them');
    expect(await fits()).toBe(true);
    await shot(page, 'inbox-filter-phone');
  });

  test('the progress line fits in Settings and on the Sources page', async ({ request, page }) => {
    await settled(request);
    for (const path of ['/settings', '/sources']) {
      await page.goto(path);
      const line = page.getByTestId('suggest-progress');
      await expect(line).toHaveText(lineRe);
      const box = (await line.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(0);
      await line.scrollIntoViewIfNeeded();
      await shot(page, `progress-phone${path.replace('/', '-')}`);
    }
  });

  test('the bulk bar says how many items it will act on, on a phone too', async ({ request, page }) => {
    await settled(request);
    await page.goto('/inbox?sug=me');
    await expect(rows(page).first()).toBeVisible();
    const total = (await inboxPage(request, 'suggestion=me')).total;
    await page.keyboard.press('*');
    await page.keyboard.press('a');
    const bar = page.getByTestId('bulk-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('bulk-count')).toHaveText(`${total} selected`);
    const box = (await bar.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390.5);
    await shot(page, 'bulk-phone');
    await page.keyboard.press('*');
    await page.keyboard.press('n');
    await expect(bar).toHaveCount(0);
  });
});

test('* a selects only the filtered list, and Done acts on exactly that', async ({ request, page }) => {
  const before = await settled(request);
  const acts = (await inboxPage(request, 'suggestion=act')).total;
  expect(acts).toBeGreaterThan(100); // more than one page, so "all" needs the rest loaded
  const none = (await inboxPage(request, 'suggestion=none')).total;

  await page.goto('/inbox?sug=act');
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('*');
  await page.keyboard.press('a');
  const count = page.getByTestId('bulk-count');
  // Only what is loaded, and the bar says so, and offers the rest.
  await expect(count).toHaveText(`100 selected of ${acts}`);
  await shot(page, 'bulk-desktop');
  await page.getByTestId('bulk-all-matching').click();
  await expect(count).toHaveText(`${acts} selected`);

  await page.getByTestId('bulk-done').click();
  await expect(page.getByTestId('toast').filter({ hasText: `${acts} items: marked done` })).toBeVisible();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);

  // Exactly the filtered items went; items with no suggestion, and every other suggestion, are still there.
  await expect.poll(async () => (await inboxPage(request, 'suggestion=act')).total).toBe(0);
  expect((await inboxPage(request, 'suggestion=none')).total).toBe(none);
  const after = await status(request);
  expect(after.total).toBe(before.total - acts);
});
