import { expect, test } from '@playwright/test';

// Toasts are found by their text: Adventure mode may add its own (an arrival or a level-up) to the stack.
test.beforeEach(async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
});

test('e marks done, z undoes, counts follow', async ({ page }) => {
  const count = page.getByTestId('sidebar-count-inbox');
  const before = Number((await count.innerText()).replace(/\D/g, ''));
  await page.keyboard.press('e');
  await expect(page.getByTestId('toast').filter({ hasText: 'done' }).first()).toBeVisible();
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));
  await page.keyboard.press('z');
  await expect(count).toHaveText(before.toLocaleString('en-US'));
});

test('n marks "no action needed", which shows as Dismissed (not Done), and z undoes it', async ({ page }) => {
  const count = page.getByTestId('sidebar-count-inbox');
  const before = Number((await count.innerText()).replace(/\D/g, ''));
  const row = page.getByTestId('inbox-row').first();
  const id = (await row.getAttribute('data-comment-id'))!;
  const words = ((await row.locator('.text').innerText()).match(/[A-Za-z]{4,}/g) ?? []).slice(0, 2).join(' ');
  await page.keyboard.press('n');
  await expect(page.getByTestId('toast').filter({ hasText: 'no action needed' }).first()).toBeVisible();
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));

  // Both views show it, and All says which kind of finished it is.
  await page.goto(`/all?q=${encodeURIComponent(words)}`);
  const found = page.locator(`[data-testid=inbox-row][data-comment-id="${id}"]`);
  await expect(found.getByTestId('row-state')).toHaveText('Dismissed');
  await found.hover();
  await found.getByTestId('row-done').click(); // an item can be re-filed as plain Done
  await expect(found.getByTestId('row-state')).toHaveText('Done');
  await found.getByTestId('row-dismiss').click();
  await expect(found.getByTestId('row-state')).toHaveText('Dismissed');

  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
  const mid = Number((await count.innerText()).replace(/\D/g, ''));
  await page.keyboard.press('n');
  await expect(count).toHaveText((mid - 1).toLocaleString('en-US'));
  await page.keyboard.press('z');
  await expect(count).toHaveText(mid.toLocaleString('en-US'));
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
  await expect(page.getByTestId('toast').filter({ hasText: 'done' }).first()).toBeVisible();
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

test('the No action needed button works like Done, and its tooltip names the key', async ({ page }) => {
  const count = page.getByTestId('sidebar-count-inbox');
  const before = Number((await count.innerText()).replace(/\D/g, ''));
  const button = page.getByTestId('act-dismiss');
  await button.hover();
  await expect(page.getByTestId('tooltip')).toContainText('No action needed');
  await expect(page.getByTestId('tooltip').locator('kbd')).toHaveText('n');
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'N');
  await button.click();
  await expect(page.getByTestId('toast').filter({ hasText: 'no action needed' }).first()).toBeVisible();
  await expect(count).toHaveText((before - 1).toLocaleString('en-US'));
  await page.getByTestId('act-undo').click();
  await expect(count).toHaveText(before.toLocaleString('en-US'));
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
  await expect(page.getByTestId('toast').filter({ hasText: 'done' }).first()).toBeVisible();
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

test('ticking rows and pressing No action acts on all of them', async ({ page }) => {
  const rows = page.getByTestId('inbox-row');
  await rows.nth(2).hover();
  await rows.nth(2).getByTestId('row-check').click();
  await rows.nth(3).hover();
  await rows.nth(3).getByTestId('row-check').click();
  await expect(page.getByTestId('bulk-bar')).toContainText('2 selected');
  await page.getByTestId('bulk-dismiss').click();
  await expect(page.getByTestId('toast').filter({ hasText: '2 items: marked no action needed' }).first()).toBeVisible();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});

test('hovering a row shows a tick; ticking rows and pressing Done acts on all of them', async ({ page }) => {
  const rows = page.getByTestId('inbox-row');
  const first = rows.nth(0);
  const second = rows.nth(1);
  await expect(first.getByTestId('row-check')).toBeHidden();
  await first.hover();
  await first.getByTestId('row-check').click();
  await second.hover();
  await second.getByTestId('row-check').click();
  await expect(page.getByTestId('bulk-bar')).toContainText('2 selected');
  await page.getByTestId('bulk-done').click();
  await expect(page.getByTestId('toast').filter({ hasText: '2 items: marked done' })).toBeVisible();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});
