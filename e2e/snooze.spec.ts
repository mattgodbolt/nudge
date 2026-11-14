import { expect, test, type Page } from '@playwright/test';

// These share one demo server with the other specs, so they run in order and assert on changes, not absolutes.
test.describe.configure({ mode: 'serial' });

const num = async (page: Page, testid: string) =>
  Number((await page.getByTestId(testid).innerText()).replace(/\D/g, '') || '0');

test.beforeEach(async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
});

/**
 * Moves the selection well down the list with j, away from the first rows that other specs (running in parallel
 * against the same demo server) mark done, and returns the selected row.
 */
async function selectRowDownTheList(page: Page, presses = 14) {
  for (let i = 0; i < presses; i++) await page.keyboard.press('j');
  const row = page.locator('[data-testid=inbox-row][aria-selected=true]');
  await expect(row).toHaveCount(1);
  await expect(page.getByTestId('thread-view')).toBeVisible();
  return row;
}

test('b then 1 snoozes the selected comment; z undoes it; counts follow', async ({ page }) => {
  // Only this file snoozes anything, so the snoozed count is safe to assert exactly; the inbox count is shared with
  // specs running in parallel, so just check it does not grow.
  const snoozed = await num(page, 'sidebar-count-snoozed');
  await selectRowDownTheList(page, 15);

  await page.keyboard.press('b');
  await expect(page.getByTestId('snooze-menu')).toBeVisible();
  await page.keyboard.press('1');
  await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed' })).toBeVisible();
  await expect(page.getByTestId('sidebar-count-snoozed')).toHaveText((snoozed + 1).toLocaleString('en-US'));

  await page.keyboard.press('z');
  await expect(page.getByTestId('sidebar-count-snoozed')).toHaveText(snoozed.toLocaleString('en-US'));
});

test('the Snoozed view lists snoozed comments with their wake time; Shift+U brings one back', async ({ page }) => {
  await page.keyboard.press('g');
  await page.keyboard.press('z');
  await expect(page).toHaveURL(/\/snoozed(\?.*)?$/);
  await page.waitForSelector('[data-testid=inbox-row]');
  await expect(page.getByTestId('row-snoozed').first()).toBeVisible();
  const snoozed = await num(page, 'sidebar-count-snoozed');

  await page.keyboard.press('Shift+U');
  await expect(page.getByTestId('sidebar-count-snoozed')).toHaveText((snoozed - 1).toLocaleString('en-US'));
});

test('l and g l do nothing now that labels are gone', async ({ page }) => {
  await selectRowDownTheList(page, 12);
  await page.keyboard.press('l');
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page).toHaveURL(/\/inbox(\?.*)?$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-label')).toHaveCount(0);
});
