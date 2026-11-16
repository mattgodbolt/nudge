import { expect, test } from './fixtures';

// Search and filters. Read-only, so it shares the hand-off demo server.

test.beforeEach(async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
});

test('a pause after a space does not eat the space', async ({ page }) => {
  const box = page.getByTestId('search');
  await page.keyboard.press('/');
  await expect(box).toBeFocused();
  await page.keyboard.type('great ');
  // Long enough for the search to go into the URL and come back.
  await expect(page).toHaveURL(/[?&]q=great(&|$)/);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await page.keyboard.type('video');
  await expect(box).toHaveValue('great video');
  await expect(page).toHaveURL(/[?&]q=great(\+|%20)video(&|$)/);
});

test('a filter that matches nothing says so (not "All caught up"), and g c clears every kind of filter', async ({
  page,
}) => {
  // This server has no GitHub feed, so no item is by a bot.
  await page.goto('/inbox?who=bots&sug=matt');
  const empty = page.getByText('Nothing matches');
  await expect(empty).toBeVisible();
  await expect(page.getByText('All caught up')).toHaveCount(0);
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page.getByTestId('inbox-row').first()).toBeVisible();
  // (The selected row's ?c= comes back by itself; no filter does.)
  expect(new URL(page.url()).search).not.toMatch(/who|sug/);
});

test('the Clear filters button clears them all too', async ({ page }) => {
  await page.goto('/inbox?kind=issue&q=zzzz-nothing');
  await page.getByRole('button', { name: /Clear filters/ }).click();
  await expect(page.getByTestId('inbox-row').first()).toBeVisible();
  expect(new URL(page.url()).search).not.toMatch(/kind|q=/);
});
