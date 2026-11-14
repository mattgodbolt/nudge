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
  await expect(page.getByTestId('thread-suggestion')).toContainText(/confidence/);
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

// The suggestion is carried out by one button, which wears a quiet ring (never acts by itself).
test('the button the suggestion points at is marked, and only that one', async ({ page }) => {
  await openInbox(page);
  const want = { act: 'row-done', skip: 'row-dismiss', spam: 'row-dismiss', reply: 'row-replied' } as const;
  const seen = new Set<string>();
  const all = await rows(page).all();
  for (const row of all.slice(0, 40)) {
    const chip = row.getByTestId('row-suggestion');
    if ((await chip.count()) === 0) continue;
    const action = (await chip.getAttribute('data-action')) as keyof typeof want;
    const turn = await chip.getAttribute('data-turn');
    if (!(action in want)) continue;
    const expected = turn === 'them' ? 'row-snooze' : want[action];
    seen.add(`${action}/${turn}`);
    for (const id of ['row-done', 'row-dismiss', 'row-replied', 'row-snooze']) {
      const mark = await row.getByTestId(id).getAttribute('data-suggested');
      expect(mark === 'true', `${action}/${turn}: ${id}`).toBe(id === expected);
    }
  }
  expect(seen.size).toBeGreaterThan(1);
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
    // Four big tiles, all the decisions made at a glance: no overflow menu.
    for (const id of ['row-done', 'row-dismiss', 'row-replied', 'row-snooze']) {
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

// The open item's header: a long title (the demo's draft "add GCC cross compiler versions ...") must keep most of the
// header's width and wrap to a few lines, with the toolbar on a row of its own rather than squeezing it into a column.
for (const [name, viewport, touch] of [
  ['1920', { width: 1920, height: 1000 }, false],
  ['1280', { width: 1280, height: 900 }, false],
  ['1000', { width: 1000, height: 900 }, false],
  ['phone', { width: 390, height: 844 }, true],
] as const) {
  test.describe(`the open GitHub item's header at ${name}`, () => {
    test.use({ viewport, hasTouch: touch });

    test('gives a long title the pane, with every action visible and nothing overflowing', async ({ page }) => {
      await page.goto('/inbox?feed=1');
      await expect(rows(page).first()).toBeVisible();
      if (touch) await page.getByTestId('search-toggle').click();
      await page.getByTestId('search').fill('add GCC cross');
      const row = rows(page).filter({ hasText: 'add GCC cross compiler versions' });
      await expect(row).toHaveCount(1);
      await row.click();
      await expect(page.getByTestId('thread-view')).toBeVisible();

      const header = page.getByTestId('thread-view').locator('header');
      const h = (await header.boundingBox())!;
      const block = (await header.locator('.vt').boundingBox())!;
      expect(block.width).toBeGreaterThanOrEqual(h.width * 0.6);

      const title = header.locator('.title');
      await expect(title).toHaveText(/add GCC cross compiler versions/);
      const lines = await title.evaluate((el) => {
        const cs = getComputedStyle(el);
        return Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight));
      });
      expect(lines).toBeLessThanOrEqual(3);

      for (const id of ['act-done', 'act-dismiss', 'act-replied', 'act-snooze', 'act-mute', 'act-undo', 'act-open']) {
        const button = page.getByTestId(id);
        await expect(button).toBeVisible();
        const b = (await button.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(h.x);
        expect(b.x + b.width).toBeLessThanOrEqual(h.x + h.width);
        expect(b.y + b.height).toBeLessThanOrEqual(h.y + h.height);
      }
      // The toolbar sits below the title block, not beside it.
      const bar = (await page.getByTestId('thread-actions').boundingBox())!;
      expect(bar.y).toBeGreaterThanOrEqual(block.y + block.height - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
  });
}
