import { expect, test, type Page } from '@playwright/test';

// A demo server with the fake, offline suggestion source (NUDGE_DEMO_SUGGEST=1): a question gets "reply", praise
// "skip", pull requests "act". Suggestions are advisory, so these tests only look at what is shown and that nothing
// else about the inbox changes.
const rows = (page: Page) => page.getByTestId('inbox-row');
const chips = (page: Page) => page.getByTestId('row-suggestion');

async function openInbox(page: Page) {
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
  // The worker runs a moment after start; chips arrive over the live channel or on the next load.
  await expect(chips(page).first()).toBeVisible({ timeout: 20_000 });
}

test('inbox rows carry a quiet hint chip with the action and the reason', async ({ page }) => {
  await openInbox(page);
  const first = chips(page).first();
  await expect(first).toHaveText(/^(reply|act|skip|spam)\b/);
  const reply = page.locator('[data-testid=row-suggestion][data-action=reply]').first();
  await expect(reply).toHaveText(/^reply · /);
  await expect(reply).toHaveAttribute('title', /^Suggestion: reply/);
  // A chip is information, never a control.
  expect(await first.evaluate((el) => el.tagName)).toBe('SPAN');
});

test('low-confidence suggestions are dimmer than confident ones', async ({ page }) => {
  await openInbox(page);
  const opacity = (conf: string) =>
    page
      .locator(`[data-testid=row-suggestion][data-confidence=${conf}]`)
      .first()
      .evaluate((el) => Number(getComputedStyle(el).opacity));
  const high = await opacity('high');
  const low = await opacity('low');
  expect(low).toBeLessThan(high);
});

test('opening an item shows the reason in full, and keys still work', async ({ page }) => {
  await openInbox(page);
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('thread-view')).toBeVisible();
  await expect(page.getByTestId('thread-suggestion')).toContainText('Suggestion: ');
});

test('Settings has a toggle that hides the chips, and the choice is remembered', async ({ page }) => {
  await openInbox(page);
  await page.goto('/settings');
  const toggle = page.getByTestId('show-suggestions');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
  await expect(chips(page)).toHaveCount(0);
  await page.goto('/settings');
  await expect(page.getByTestId('show-suggestions')).not.toBeChecked();
  await page.getByTestId('show-suggestions').check();
  await page.goto('/inbox');
  await expect(chips(page).first()).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the chip fits inside the row without widening the page or crowding the quick actions', async ({ page }) => {
    await openInbox(page);
    const row = rows(page).first();
    const chip = row.getByTestId('row-suggestion');
    await expect(chip).toBeVisible();
    const r = (await row.boundingBox())!;
    const c = (await chip.boundingBox())!;
    expect(c.x).toBeGreaterThanOrEqual(r.x);
    expect(c.x + c.width).toBeLessThanOrEqual(r.x + r.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // It sits above the row of action tiles, not on them.
    const quick = (await row.getByRole('group', { name: 'Quick actions' }).boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual(quick.y + 1);
  });

  // The list is virtualised with one fixed row height, so a row that grows (taller badges, a wrapped badge, a chip
  // line) would have its action tiles cut off at the bottom.
  test('a GitHub row with a hint chip and labels shows its whole row of action tiles, and nothing runs off the edge', async ({
    page,
  }) => {
    // Comments are classified first (they are newer), so the GitHub items get theirs a little later: reload until one has.
    // (The demo server lifts the per-pass cap so that one pass reaches them.)
    const row = rows(page)
      .filter({ has: page.getByTestId('row-suggestion') })
      .filter({ has: page.getByTestId('row-kind') });
    await expect(async () => {
      await page.goto('/inbox?feed=1');
      await expect(rows(page).first()).toBeVisible();
      await expect(row.first()).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 90_000, intervals: [2_000] });
    const withLabels = row.filter({ hasText: 'discussion' });
    const target = (await withLabels.count()) > 0 ? withLabels.first() : row.first();
    const r = (await target.boundingBox())!;
    for (const id of ['row-snooze', 'row-label', 'row-done']) {
      const b = (await target.getByTestId(id).boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(50);
      expect(b.y).toBeGreaterThanOrEqual(r.y);
      expect(b.y + b.height).toBeLessThanOrEqual(r.y + r.height);
      expect(b.x + b.width).toBeLessThanOrEqual(r.x + r.width);
    }
    // Every badge stays on one line, and labels stop at the row's right edge.
    for (const el of await target.locator('.badge, .ghlabel').all()) {
      const b = (await el.boundingBox())!;
      expect(b.height).toBeLessThanOrEqual(20);
      expect(b.x + b.width).toBeLessThanOrEqual(r.x + r.width);
    }
  });
});
