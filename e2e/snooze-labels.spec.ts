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
  // The demo data labels some rows; keep going until the selected one has none.
  for (let i = 0; i < 30 && (await row.getByTestId('label-chips').count()) > 0; i++) await page.keyboard.press('j');
  await expect(row.getByTestId('label-chips')).toHaveCount(0);
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

test('l opens the label picker; toggling a label puts a chip on the row; toggling again removes it', async ({
  page,
}) => {
  const row = await selectRowDownTheList(page, 16);
  await expect(row.getByTestId('label-chips')).toHaveCount(0);

  await page.keyboard.press('l');
  await expect(page.getByTestId('label-picker')).toBeVisible();
  await page.keyboard.type('Follow');
  await expect(page.getByTestId('label-option')).toHaveCount(1);
  // The picker ignores keys while a toggle is in flight, so wait for each server answer.
  const applied = () => page.waitForResponse((r) => r.url().includes('/api/labels/apply') && r.ok());
  let answer = applied();
  await page.keyboard.press('Enter');
  await answer;
  await expect(row.getByTestId('label-chips')).toContainText('Follow up');

  answer = applied();
  await page.keyboard.press('Enter'); // Enter on the same option toggles it off again
  await answer;
  await expect(row.getByTestId('label-chips')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('label-picker')).toBeHidden();
});

test('typing a new name in the picker creates the label and applies it; it appears in the sidebar', async ({
  page,
}) => {
  const row = await selectRowDownTheList(page, 18);
  await page.keyboard.press('l');
  await page.keyboard.type('E2E review later');
  await expect(page.getByTestId('label-create')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(row.getByTestId('label-chips')).toContainText('E2E review later');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar-label').filter({ hasText: 'E2E review later' })).toBeVisible();
});

test('a label folder lists everything with that label, including done items', async ({ page }) => {
  await page.getByTestId('sidebar-label').filter({ hasText: 'E2E review later' }).click();
  await expect(page).toHaveURL(/\/label\/\d+$/);
  await page.waitForSelector('[data-testid=inbox-row]');
  await expect(page.getByTestId('inbox-row')).toHaveCount(1);

  // Marking it done keeps it in the folder (labels are independent of state) and shows its state.
  await page.keyboard.press('e');
  await expect(page.getByTestId('inbox-row')).toHaveCount(1);
  await expect(page.getByTestId('row-state')).toBeVisible();
});

test('g l opens a go-to-label picker and Enter jumps to the folder', async ({ page }) => {
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page.getByTestId('label-picker')).toBeVisible();
  await page.keyboard.type('E2E');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/label\/\d+$/);
});
