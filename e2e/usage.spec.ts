import { expect, test } from './fixtures';

const day = (offset: number) => new Date(Date.UTC(2026, 10, 11 + offset)).toISOString().slice(0, 10);

const mocked = {
  days: 7,
  from: day(-6),
  to: day(0),
  rows: [
    { day: day(-1), key: 'done.kbd', count: 12 },
    { day: day(0), key: 'done.btn', count: 3 },
    { day: day(0), key: 'snooze.touch', count: 4 },
    { day: day(0), key: 'view.stats', count: 2 },
    { day: day(0), key: 'assistant.call', count: 5 },
    { day: day(0), key: 'assistant.cost_micros', count: 4200 },
    { day: day(0), key: 'device.phone', count: 1 },
  ],
  events: [{ day: day(0), kind: 'state', source: 'user', count: 9 }],
  unused: ['mute', 'reply'],
};

test('Stats shows the Usage section with mocked data, and demo mode never reports usage', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/usage') && r.method() === 'POST') posts.push(r.url());
  });
  await page.route('**/api/usage?days=*', (route) => route.fulfill({ json: mocked }));

  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
  await page.keyboard.press('j');
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/stats$/);

  const usage = page.getByTestId('usage-section');
  await expect(usage).toBeVisible();
  await expect(page.getByTestId('usage-top')).toContainText('Done');
  await expect(page.getByTestId('usage-top')).toContainText('15');
  await expect(page.getByTestId('usage-via')).toContainText('Keyboard');
  await expect(page.getByTestId('usage-assistant')).toContainText('$0.004');
  await expect(page.getByTestId('usage-events')).toContainText('State');
  await expect(page.getByTestId('usage-unused')).toContainText('Mute');
  await expect(page.getByTestId('usage-days').locator('.col')).toHaveCount(7);

  // Nothing is written from a demo server, however much the page was used.
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
});

test('switching 7 → 30 → 7 days quickly shows 7 days, whichever answer arrives last', async ({ page }) => {
  const month = {
    ...mocked,
    days: 30,
    from: day(-29),
    rows: Array.from({ length: 30 }, (_, i) => ({ day: day(-i), key: 'done.kbd', count: 1 })),
  };
  const gate: { open?: () => void } = {};
  await page.route('**/api/usage?days=*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('days') === '30') {
      await new Promise<void>((r) => (gate.open = r));
      await route.fulfill({ json: month });
    } else await route.fulfill({ json: mocked });
  });
  await page.goto('/stats');
  const days = page.getByTestId('usage-days').locator('.col');
  await expect(days).toHaveCount(7);
  const usage = page.getByTestId('usage-section');
  await usage.getByRole('button', { name: '30 days' }).click();
  await expect.poll(() => !!gate.open).toBe(true);
  await usage.getByRole('button', { name: '7 days' }).click();
  await expect(days).toHaveCount(7);
  const answered = page.waitForResponse((r) => r.url().includes('days=30'));
  gate.open!();
  await answered;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));
  await expect(days).toHaveCount(7);
});
