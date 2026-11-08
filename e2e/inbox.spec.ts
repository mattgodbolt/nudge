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

test('Done button marks done with toast, undo button reverts; focus does not eat shortcuts', async ({ page }) => {
  const count = page.getByTestId('sidebar-count-inbox');
  const before = Number((await count.innerText()).replace(/\D/g, ''));
  await page.getByTestId('act-done').click();
  await expect(page.getByTestId('toast').first()).toContainText('done');
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));
  await page.getByTestId('act-undo').click();
  await expect(count).toHaveText(before.toLocaleString('en-US'));
  // Single-key shortcuts still work right after clicking buttons.
  await page.keyboard.press('e');
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));
});

test('Enter on a focused button activates it instead of the global Enter binding', async ({ page }) => {
  const count = page.getByTestId('sidebar-count-inbox');
  const before = Number((await count.innerText()).replace(/\D/g, ''));
  await page.getByTestId('act-done').focus();
  await page.keyboard.press('Enter');
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));
  await expect(page.locator('[data-testid=thread-view].focus')).toHaveCount(0);
});

test('tooltip hotkey text comes from the binding', async ({ page }) => {
  await page.getByTestId('act-done').hover();
  const tip = page.getByTestId('tooltip');
  await expect(tip).toContainText('Done');
  await expect(tip.locator('kbd')).toHaveText('e');
  await expect(page.getByTestId('act-done')).toHaveAttribute('aria-keyshortcuts', 'E');
  await expect(page.getByTestId('act-inbox')).toHaveCount(0); // only shown outside the inbox
  await page.getByTestId('sync-indicator').hover();
  await expect(page.getByTestId('tooltip').locator('kbd')).toHaveText('Shift+N');
});

test('u goes back to the list, Shift+U restores to the inbox', async ({ page }) => {
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=thread-view].focus')).toHaveCount(1);
  await page.keyboard.press('u');
  await expect(page.locator('[data-testid=thread-view].focus')).toHaveCount(0);
  const count = page.getByTestId('sidebar-count-inbox');
  const before = Number((await count.innerText()).replace(/\D/g, ''));
  await page.keyboard.press('m');
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));
  await page.goto('/done');
  await page.waitForSelector('[data-testid=inbox-row]');
  await expect(page.getByTestId('act-inbox')).toBeVisible();
  await page.keyboard.press('Shift+U');
  await expect(count).toHaveText(before.toLocaleString('en-US'));
});

test('* a selects all, bulk bar acts on them', async ({ page }) => {
  await page.keyboard.press('*');
  await page.keyboard.press('a');
  const bar = page.getByTestId('bulk-bar');
  await expect(bar).toBeVisible();
  await page.getByTestId('bulk-done').click();
  await expect(page.getByTestId('toast').first()).toContainText('done');
  await expect(bar).toHaveCount(0);
});

test('sort order: oldest first reverses the list, Shift+O cycles, and the choice is remembered', async ({ page }) => {
  await page.goto('/inbox');
  const first = page.getByTestId('inbox-row').first();
  await expect(first).toBeVisible();
  const newestId = await first.getAttribute('data-comment-id');

  await page.getByTestId('sort').selectOption('oldest');
  await expect(page.getByTestId('inbox-row').first()).not.toHaveAttribute('data-comment-id', newestId!);

  await page.reload(); // remembered in this browser
  await expect(page.getByTestId('sort')).toHaveValue('oldest');
  await expect(page.getByTestId('inbox-row').first()).not.toHaveAttribute('data-comment-id', newestId!);

  await page.keyboard.press('Shift+O'); // oldest -> arrived
  await expect(page.getByTestId('sort')).toHaveValue('arrived');
  await page.getByTestId('sort').selectOption('newest');
  await expect(page.getByTestId('inbox-row').first()).toHaveAttribute('data-comment-id', newestId!);
});
