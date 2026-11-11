import { expect, test } from '@playwright/test';

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
