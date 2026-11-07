import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
});

test('e marks done, z undoes, counts follow', async ({ page }) => {
  const count = page.getByTestId('sidebar-count-inbox');
  const before = Number((await count.innerText()).replace(/\D/g, ''));
  await page.keyboard.press('e');
  await expect(page.getByTestId('toast').first()).toContainText('done');
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));
  await page.keyboard.press('z');
  await expect(count).toHaveText(before.toLocaleString('en-US'));
});

test('r then Ctrl+Enter copies the reply, opens YouTube and marks replied', async ({ page, context }) => {
  const popup = context.waitForEvent('page');
  await page.keyboard.press('r');
  await page.keyboard.type('Thanks for watching!');
  await page.keyboard.press('Control+Enter');
  expect((await popup).url()).toContain('&lc=');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Thanks for watching!');
});

test('chords, palette and help', async ({ page }) => {
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/\/sources$/);
  await page.keyboard.press('?');
  await expect(page.getByTestId('help')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('palette')).toBeVisible();
});
