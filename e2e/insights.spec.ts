import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Insights } from '../shared/insights';

// Insights on Stats (docs/INSIGHTS.md), on a private demo server seeded with weeks of made-up history
// (NUDGE_DEMO_HISTORY=1) plus the fake GitHub feed. The history is written once, shortly after start-up, so every
// test first waits for it. Screenshots go to $NUDGE_SHOTS when it is set.
const SHOTS = process.env.NUDGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};

async function seeded(request: APIRequestContext) {
  await expect
    .poll(
      async () => {
        const r = (await (await request.get('/api/insights?range=30d&tz=UTC')).json()) as Insights;
        return r.rhythm.actions.data !== null && r.backlog.overTime.data !== null;
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
}

async function openStats(page: Page) {
  await page.goto('/stats');
  await expect(page.getByTestId('insights-sentence')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await seeded(request);
});

test('the panel leads Stats with the sentence, the range, and cards with charts', async ({ page }) => {
  await openStats(page);
  const section = page.getByTestId('insights-section');
  // It comes before the video totals and Usage.
  const order = await page.evaluate(() =>
    ['insights-section', 'stat-tiles', 'usage-section'].map(
      (id) => document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect().top ?? -1,
    ),
  );
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);

  await expect(page.getByTestId('insights-sentence')).toHaveText(/^You (answered|cleared) \d+ thing/);
  await expect(page.getByTestId('insights-range-30d')).toHaveAttribute('aria-pressed', 'true');
  await expect(section.getByTestId('insight-arrivals').getByTestId('heatmap')).toBeVisible();
  await expect(section.getByTestId('insight-actions').getByTestId('heatmap')).toBeVisible();
  await expect(section.getByTestId('insight-outcomes').getByTestId('segbar')).toBeVisible();
  await expect(section.getByTestId('insight-over-time').getByTestId('linechart')).toBeVisible();
  await expect(section.getByTestId('insight-agreement').getByTestId('stat-value')).toHaveText(/^\d+%$/);
  // Captions describe; numbers carry their n.
  await expect(section.getByTestId('insight-arrivals').getByTestId('insight-caption')).toHaveText(/^Peak arrivals: /);
  await expect(section.getByTestId('insight-by-suggestion').getByTestId('meter-row').first()).toContainText(
    /n=\d+|of 10/,
  );
  // Charts are images with a summary for screen readers.
  await expect(section.getByTestId('insight-arrivals').getByRole('img').first()).toHaveAttribute(
    'aria-label',
    /Busiest/,
  );
});

test('switching the range refetches, keeps the frame, and is remembered', async ({ page }) => {
  await openStats(page);
  const scope = page.getByTestId('insights-section').locator('.scope');
  await expect(scope).toContainText('The last 30 days');
  const asked = page.waitForRequest((r) => r.url().includes('/api/insights') && r.url().includes('range=7d'));
  await page.getByTestId('insights-range-7d').click();
  await asked;
  await expect(page.getByTestId('insights-range-7d')).toHaveAttribute('aria-pressed', 'true');
  await expect(scope).toContainText('The last 7 days');
  await page.getByTestId('insights-range-all').click();
  await expect(scope).toContainText('Everything since');
  await page.getByTestId('insights-range-90d').click();
  await expect(scope).toContainText('The last 90 days');
  await page.reload();
  await expect(page.getByTestId('insights-range-90d')).toHaveAttribute('aria-pressed', 'true');
  await expect(scope).toContainText('The last 90 days');
  // The zone the browser is in goes with the request.
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(scope).toContainText(`Times are ${tz}`);
});

test('when a new range fails to load over the old one, it says the numbers are still the old range', async ({
  page,
}) => {
  await openStats(page);
  const scope = page.getByTestId('insights-section').locator('.scope');
  await expect(scope).toContainText('The last 30 days');
  await page.route(
    (url) => url.pathname === '/api/insights' && url.searchParams.get('range') === '7d',
    (route) => route.fulfill({ status: 500, json: { error: 'boom', code: 'internal' } }),
  );
  await page.getByTestId('insights-range-7d').click();
  await expect(page.getByTestId('insights-failed')).toContainText('Could not load');
  await expect(page.getByTestId('insights-failed')).toContainText('the last 30 days');
});

test('every chart has a table view, cells answer a tap, and item links open the item', async ({ page }) => {
  await openStats(page);
  const arrivals = page.getByTestId('insight-arrivals');
  await arrivals.getByTestId('heatmap').locator('.cell').nth(30).click();
  await expect(arrivals.locator('.readout')).toContainText(/a (Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*day \(\d+ in all\)/);
  await arrivals.getByRole('button', { name: 'Show as table' }).click();
  await expect(arrivals.locator('table').first()).toContainText('Written');
  await expect(arrivals.getByTestId('heatmap')).toHaveCount(0);
  await arrivals.getByRole('button', { name: 'Show chart' }).click();
  await expect(arrivals.getByTestId('heatmap')).toBeVisible();

  const elder = page.getByTestId('insight-elder');
  const link = elder.getByRole('link');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/all\?c=/);
});

test('reading insights changes nothing in the inbox', async ({ page, request }) => {
  const snapshot = async () => {
    const out: unknown[] = [];
    for (const view of ['inbox', 'done', 'all', 'snoozed'])
      out.push(await (await request.get(`/api/inbox?view=${view}&limit=500`)).json());
    out.push(((await (await request.get('/api/bootstrap')).json()) as { counts: unknown }).counts);
    return JSON.stringify(out);
  };
  const before = await snapshot();
  await openStats(page);
  for (const r of ['7d', '30d', '90d', 'all']) {
    const done = page.waitForResponse((res) => res.url().includes(`range=${r}`) && res.ok());
    await page.getByTestId(`insights-range-${r}`).click();
    await done;
  }
  // Each click renames its button to "Show chart", so always take the first one left.
  const tables = page.getByRole('button', { name: 'Show as table' });
  for (let left = await tables.count(); left > 0; left--) {
    await tables.first().click();
    await expect(tables).toHaveCount(left - 1);
  }
  for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'])
    expect((await request.get(`/api/insights?range=all&tz=${encodeURIComponent(tz)}`)).ok()).toBe(true);
  expect(await snapshot()).toBe(before);
});

test('an empty history shows one friendly line; a thin one says how far each card is from enough', async ({
  page,
  request,
}) => {
  // The server's own empty and low-data answers are covered by server/db/insights.test.ts; here the page is handed
  // them, built from a real report, to check what it draws.
  const real = (await (await request.get('/api/insights?range=30d&tz=UTC')).json()) as Insights;
  const thin = structuredClone(real);
  for (const g of ['rhythm', 'responses', 'predictions'] as const)
    for (const c of Object.values(thin[g]) as { n: number; data: unknown }[]) {
      c.n = 3;
      c.data = null;
    }
  thin.sentence = 'A quiet month. Lovely.';
  let body: Insights = thin;
  await page.route('**/api/insights*', (route) => route.fulfill({ json: body }));
  await openStats(page);
  await expect(page.getByTestId('insights-sentence')).toHaveText('A quiet month. Lovely.');
  await expect(page.getByTestId('group-empty-rhythm')).toContainText('not enough data yet (3 of 50 arrivals');
  await expect(page.getByTestId('group-empty-predictions')).toBeVisible();
  await expect(page.getByTestId('insight-repos')).toBeVisible(); // sources still have theirs
  await shot(page, 'insights-low-data');

  // One card short in an otherwise full group keeps its title and says so.
  body = structuredClone(real);
  body.responses.undos = { n: 0, min: 1, data: null };
  await page.reload();
  await expect(page.getByTestId('insight-undos').getByTestId('insight-low')).toHaveText('Not enough data yet (0 of 1)');
  await expect(page.getByTestId('insight-undos').getByRole('heading')).toHaveText('Undo corner');

  const empty = structuredClone(real);
  empty.empty = true;
  body = empty;
  await page.reload();
  await expect(page.getByTestId('insights-empty')).toContainText(
    'Insights appear once things arrive and you deal with them.',
  );
  await expect(page.getByTestId('insight-arrivals')).toHaveCount(0);
  // The rest of Stats is still there.
  await expect(page.getByTestId('usage-section')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('one column, no sideways scrolling, readable heatmap cells', async ({ page }) => {
    await openStats(page);
    const widths = await page.evaluate(() => {
      const scroller = document.querySelector('.page') as HTMLElement;
      return {
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        page: scroller.scrollWidth - scroller.clientWidth,
      };
    });
    expect(widths.doc).toBeLessThanOrEqual(0);
    expect(widths.page).toBeLessThanOrEqual(0);
    const vw = 390;
    const cards = page.getByTestId('insights-section').locator('article');
    const n = await cards.count();
    expect(n).toBeGreaterThan(20);
    const xs = new Set<number>();
    for (let k = 0; k < n; k++) {
      const box = (await cards.nth(k).boundingBox())!;
      expect(box.x, `card ${k}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `card ${k}`).toBeLessThanOrEqual(vw + 0.5);
      xs.add(Math.round(box.x));
    }
    expect(xs.size).toBe(1); // a single column
    // Hours run down the page: 24 rows, 7 columns, cells at least 12px wide.
    const cell = (await page.getByTestId('insight-arrivals').locator('.cell').first().boundingBox())!;
    expect(cell.width).toBeGreaterThanOrEqual(12);
    const heat = (await page.getByTestId('insight-arrivals').getByTestId('heatmap').boundingBox())!;
    expect(heat.height).toBeGreaterThan(heat.width);
    // Nothing inside a card spills past it.
    const spills = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=insights-section] article')]
        .filter((a) => a.scrollWidth > a.clientWidth + 1)
        .map((a) => a.getAttribute('data-testid')),
    );
    expect(spills).toEqual([]);
  });
});

// Light and dark, desktop and phone: the page picks the scheme up from the system, and with $NUDGE_SHOTS set the
// whole section is captured in screen-sized pieces for a look by eye.
for (const scheme of ['light', 'dark'] as const) {
  for (const [device, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    test(`renders in ${scheme} on ${device}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await openStats(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      // The sequential ramp is the theme's own: a dark page never shows the light ramp's palest step.
      const swatch = await page
        .getByTestId('insight-arrivals')
        .locator('.legend .sw')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(swatch).toBe(scheme === 'light' ? 'rgb(205, 226, 251)' : 'rgb(19, 48, 79)');
      if (!SHOTS) return;
      const box = (await page.getByTestId('insights-section').boundingBox())!;
      const scroller = page.locator('.page');
      for (let y = 0, k = 0; y < box.y + box.height && k < 14; y += viewport.height - 80, k++) {
        await scroller.evaluate((el, top) => el.scrollTo(0, top), y);
        await shot(page, `insights-${device}-${scheme}-${String(k).padStart(2, '0')}`);
      }
    });
  }
}
