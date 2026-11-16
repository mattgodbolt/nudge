import { expect, test } from '@playwright/test';

test('stats page shows aggregate totals, switches scope, and g t navigates there', async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/stats$/);

  const videos = Number((await page.getByTestId('stat-videos').innerText()).replace(/\D/g, ''));
  expect(videos).toBeGreaterThan(30);
  // Demo videos all have a length, so the total is days/hours/minutes, not zero.
  await expect(page.getByTestId('stat-duration')).toHaveText(/\d+[dh] \d+m|\d+h \d+m/);
  expect(Number((await page.getByTestId('stat-video-likes').innerText()).replace(/\D/g, ''))).toBeGreaterThan(0);
  expect(Number((await page.getByTestId('stat-comment-likes').innerText()).replace(/\D/g, ''))).toBeGreaterThanOrEqual(
    0,
  );
  await expect(page.getByTestId('stats-table').locator('tbody tr').first()).toBeVisible();

  // The shared demo server may have had its own-channel flag toggled by another spec, so only check the scope switch
  // when it is offered.
  const toggle = page.getByRole('button', { name: 'My channels' });
  if (await toggle.isVisible()) {
    await toggle.click();
    const mine = Number((await page.getByTestId('stat-videos').innerText()).replace(/\D/g, ''));
    expect(mine).toBeGreaterThan(0);
    expect(mine).toBeLessThanOrEqual(videos);
  }
});

test('when the totals cannot be loaded the page says so and offers Retry, rather than "Nothing tracked yet"', async ({
  page,
}) => {
  let fail = true;
  await page.route(
    (url) => url.pathname === '/api/stats',
    (route) =>
      fail
        ? route.fulfill({ status: 500, json: { error: 'Database is having a moment', code: 'internal' } })
        : route.fallback(),
  );
  await page.goto('/stats');
  await expect(page.getByText("Couldn't load the totals")).toBeVisible();
  await expect(page.getByText('Nothing tracked yet')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('stat-videos')).toBeVisible();
});
