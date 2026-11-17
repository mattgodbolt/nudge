import { expect, test, type Page } from './fixtures';

// A private demo server (NUDGE_DEMO_SUGGEST=1, NUDGE_DEMO_COMMENTS=1): the fake suggestion source judges a GitHub
// thread by who wrote last ("your turn · answer alice-maintainer", "waiting on them"), uses the owner's snooze note and
// notes, and the fake assistant understands "snooze this tomorrow to <why>" and notes (anything with "always",
// "never", "wouldn't" or "suggestion"). The tests change what they look at, so they run in order.
test.describe.configure({ mode: 'serial' });

const rows = (page: Page) => page.getByTestId('inbox-row');
const withTurn = (page: Page, turn: 'me' | 'them') =>
  rows(page).filter({ has: page.locator(`[data-testid=row-suggestion][data-turn=${turn}]`) });
const SHOTS = process.env.NUDGE_SHOTS;
const shot = async (page: Page, name: string) => {
  // Let the sheet and fade-in animations finish first.
  if (SHOTS) await page.waitForTimeout(500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

/** GitHub rows get their suggestion a little after the comments do: reload until some have one with a turn. */
async function openGithub(page: Page) {
  await expect(async () => {
    await page.goto('/inbox?feed=1');
    await expect(rows(page).first()).toBeVisible();
    await expect(withTurn(page, 'me').first()).toBeVisible({ timeout: 1_000 });
    await expect(withTurn(page, 'them').first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000] });
}

test.beforeAll(async ({ request }) => {
  // The fake assistant only runs with a key set.
  const res = await request.put('/api/settings', {
    headers: { 'X-Nudge': '1' },
    data: { llm: { apiKey: 'sk-ant-demo-1234' } },
  });
  expect(res.ok()).toBe(true);
});

/** The row of the note whose text starts with `start` (the text sits in a textarea, which text filters cannot see). */
async function noteRow(page: Page, start: string) {
  const all = page.getByTestId('note-row');
  await expect(all.first()).toBeVisible();
  for (let i = 0; i < (await all.count()); i++) {
    if ((await all.nth(i).getByTestId('note-text').inputValue()).startsWith(start)) return all.nth(i);
  }
  throw new Error(`no note starting "${start}"`);
}

async function tell(page: Page, text: string) {
  await page.keyboard.press('c');
  await expect(page.getByTestId('assistant')).toBeVisible();
  await page.getByTestId('assistant-input').fill(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('assistant')).toBeHidden();
}

test('a chip says whose turn it is and the next step, and the open item spells it out', async ({ page }) => {
  await openGithub(page);
  const mine = withTurn(page, 'me').first().getByTestId('row-suggestion');
  await expect(mine).toHaveText(/^your turn · answer \S+/);
  await expect(mine).toHaveAttribute('title', /^Suggestion: your turn · answer \S+/);
  const theirs = withTurn(page, 'them').first().getByTestId('row-suggestion');
  await expect(theirs).toHaveText('waiting on them');
  await shot(page, 'desktop-chips');
  await withTurn(page, 'me').first().click();
  await expect(page.getByTestId('thread-suggestion')).toContainText('Your turn · answer');
});

// The suggestion must stay readable at any width: a row's chip has the row's width, the repo and badge are never
// squeezed to a stub, and the open item's block sits whole inside its header, a few lines at most.
for (const [name, width, height] of [
  ['desktop', 1280, 800],
  ['wide desktop', 1920, 1000],
  ['phone', 390, 844],
] as const) {
  test(`suggestions are not clipped or squeezed at ${name} width`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openGithub(page);
    const row = withTurn(page, 'me').first();
    const r = (await row.boundingBox())!;
    const chip = (await row.getByTestId('row-suggestion').boundingBox())!;
    expect(chip.x).toBeGreaterThanOrEqual(r.x);
    expect(chip.x + chip.width).toBeLessThanOrEqual(r.x + r.width);
    expect(chip.y).toBeGreaterThanOrEqual(r.y);
    expect(chip.y + chip.height).toBeLessThanOrEqual(r.y + r.height);
    expect(chip.height).toBeLessThanOrEqual(20);
    expect(chip.width).toBeGreaterThanOrEqual(Math.min(260, r.width * 0.6));
    // The repo and the PR badge keep their room, and nothing on the line is a stub.
    const kind = (await row.getByTestId('row-kind').boundingBox())!;
    expect(kind.y + kind.height).toBeLessThanOrEqual(chip.y + 1);
    const repo = row.locator('.vtitle');
    expect((await repo.boundingBox())!.width).toBeGreaterThanOrEqual(110);
    expect(await repo.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const l of await row.locator('.ghlabel').all()) {
      if (!(await l.isVisible())) continue;
      const b = (await l.boundingBox())!;
      if (b.y + b.height > r.y + r.height || b.y < r.y) continue; // wrapped out of sight: whole or not at all
      expect(await l.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await row.click();
    const block = page.getByTestId('thread-suggestion');
    await expect(block).toBeVisible();
    const header = (await page.locator('[data-testid=thread-view] header').boundingBox())!;
    const b = (await block.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(header.x);
    expect(b.x + b.width).toBeLessThanOrEqual(header.x + header.width + 1);
    expect(b.y).toBeGreaterThanOrEqual(header.y);
    expect(b.y + b.height).toBeLessThanOrEqual(header.y + header.height + 1);
    // Wide enough to read, a handful of lines at most.
    expect(b.width).toBeGreaterThanOrEqual(Math.min(300, width - 40));
    expect(b.height).toBeLessThanOrEqual(110);
    await expect(block.locator('.lead')).toContainText(/^Your turn · answer /);
    await expect(block.locator('.why')).toContainText('confidence');
    await shot(page, `suggestion-${width}`);
  });
}

test('b, Tab, a reason, Enter snoozes with a why that shows in the row and the open item; b then 1 still needs no extra key', async ({
  page,
}) => {
  await openGithub(page);
  const target = withTurn(page, 'me').first();
  const title = (await target.getByTestId('row-title').innerText()).trim();
  await target.click();
  await expect(page.getByTestId('thread-view')).toBeVisible();

  await page.keyboard.press('b');
  await expect(page.getByTestId('snooze-menu')).toBeVisible();
  // j/k and the digits still drive the list until the reason box has focus.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('snooze-why')).toBeFocused();
  await page.getByTestId('snooze-why').fill('review the proposed fix and merge');
  await shot(page, 'desktop-snooze-why');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('snooze-menu')).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until' })).toBeVisible();

  await page.goto('/snoozed');
  const row = rows(page).filter({ hasText: title });
  await expect(row.getByTestId('row-why')).toHaveText('You snoozed this to: review the proposed fix and merge');
  await row.click();
  // A reason bucket may be filed after it (the demo's stand-in model does), quietly, in the same line.
  await expect(page.getByTestId('thread-why')).toContainText('You snoozed this to: review the proposed fix and merge');
  await shot(page, 'desktop-snoozed-why');

  // The fast path: no reason, one keypress for the time, exactly as before.
  await openGithub(page);
  const second = withTurn(page, 'them').first();
  const secondTitle = (await second.getByTestId('row-title').innerText()).trim();
  await second.click();
  await page.keyboard.press('b');
  await expect(page.getByTestId('snooze-why')).toHaveValue('');
  await page.keyboard.press('1');
  await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until' }).last()).toBeVisible();
  await page.goto('/snoozed');
  await expect(rows(page).filter({ hasText: secondTitle })).toBeVisible();
  await expect(rows(page).filter({ hasText: secondTitle }).getByTestId('row-why')).toHaveCount(0);
});

test('the assistant takes a why with the snooze', async ({ page }) => {
  await openGithub(page);
  const target = withTurn(page, 'me').first();
  const title = (await target.getByTestId('row-title').innerText()).trim();
  await target.click();
  await tell(page, 'snooze this tomorrow to chase the maintainer');
  await expect(page.getByText(/Snoozed until .*: chase the maintainer/)).toBeVisible();
  await page.goto('/snoozed');
  await expect(rows(page).filter({ hasText: title }).getByTestId('row-why')).toContainText('chase the maintainer');
});

test('"I wouldn\'t have snoozed that" is kept against the item he just snoozed, with what he did and why', async ({
  page,
}) => {
  await openGithub(page);
  const target = withTurn(page, 'me').first();
  const title = (await target.getByTestId('row-title').innerText()).trim();
  await target.click();
  await page.keyboard.press('b');
  await page.getByTestId('snooze-why').fill('wait for CI');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until' })).toBeVisible();
  // The selection has moved on to the next row by now: "that" is still the one he just snoozed.
  await tell(page, "I wouldn't have snoozed that, it's from my friend Bob");
  await expect(page.getByText(/^Noted: I wouldn't have snoozed that/)).toBeVisible();
  await page.goto('/settings');
  const note = await noteRow(page, "I wouldn't have snoozed that");
  await expect(note.getByTestId('note-item')).toHaveText(title);
  await expect(note).toContainText('You had just snoozed it to: wait for CI');
});

test('a standing note reaches every suggestion, can be edited, switched off and deleted; the model hears about each change', async ({
  page,
}) => {
  await openGithub(page);
  const target = withTurn(page, 'me').first();
  await target.click();
  await tell(page, 'alice-maintainer is always important');
  await expect(page.getByText(/^Noted as a standing preference/)).toBeVisible();

  const matches = page.locator('[data-testid=row-suggestion]', { hasText: 'matches one of your standing notes' });
  await expect(async () => {
    await page.goto('/inbox?feed=1');
    await expect(rows(page).first()).toBeVisible();
    await expect(matches.first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000, intervals: [1_000] });

  await page.goto('/settings');
  const note = await noteRow(page, 'alice-maintainer is always important');
  await expect(note.getByTestId('note-scope')).toHaveText('Standing');
  await page.getByTestId('settings-notes').scrollIntoViewIfNeeded();
  await shot(page, 'desktop-notes');

  // Edit the words.
  await note.getByTestId('note-text').fill('alice-maintainer is very important');
  await note.getByTestId('note-text').blur();
  await page.reload();
  const edited = await noteRow(page, 'alice-maintainer is very important');
  await expect(edited.getByTestId('note-text')).toHaveValue('alice-maintainer is very important');

  // Switch it off: still on record, no longer fed to the model, so the suggestions go back.
  await edited.getByTestId('note-enabled').uncheck();
  await expect(async () => {
    await page.goto('/inbox?feed=1');
    await expect(rows(page).first()).toBeVisible();
    await expect(matches).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 30_000, intervals: [1_000] });
  await page.goto('/settings');
  const off = await noteRow(page, 'alice-maintainer is very important');
  await expect(off.getByTestId('note-enabled')).not.toBeChecked();

  await off.getByTestId('note-delete').click();
  await page.reload();
  await expect(page.getByTestId('settings-notes')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('[data-testid=note-text]').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value)),
    )
    .not.toContain('alice-maintainer is very important');
});

test('a note about one item re-judges that item straight away', async ({ page }) => {
  await openGithub(page);
  const target = withTurn(page, 'them').first();
  const title = (await target.getByTestId('row-title').innerText()).trim();
  await target.click();
  await tell(page, 'that suggestion is wrong, I am waiting on a fix');
  await expect(page.getByText(/^Noted: that suggestion is wrong/)).toBeVisible();
  const row = rows(page).filter({ hasText: title });
  await expect(row.getByTestId('row-suggestion')).toHaveText(
    /^your turn · act on your note: that suggestion is wrong/,
    {
      timeout: 20_000,
    },
  );
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the snooze sheet has an optional why field that fits and submits with the keyboard Enter', async ({ page }) => {
    await openGithub(page);
    const target = withTurn(page, 'me').first();
    const title = (await target.getByTestId('row-title').innerText()).trim();
    await target.getByTestId('row-snooze').tap();
    const menu = page.getByTestId('snooze-menu');
    await expect(menu).toBeVisible();
    const why = page.getByTestId('snooze-why');
    await expect(why).toBeVisible();
    const m = (await menu.boundingBox())!;
    const w = (await why.boundingBox())!;
    expect(w.x).toBeGreaterThanOrEqual(m.x);
    expect(w.x + w.width).toBeLessThanOrEqual(m.x + m.width);
    expect(w.height).toBeGreaterThanOrEqual(44);
    // The sheet slides up for a moment: it must settle with the field fully on screen.
    await expect(async () => {
      const b = (await why.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(844);
    }).toPass({ timeout: 3_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, 'phone-snooze-why');
    await why.fill('read the design doc first');
    // Enter takes the highlighted time (the first: later today), as it always did.
    await why.press('Enter');
    await expect(menu).toBeHidden();
    await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until' })).toBeVisible();
    await page.goto('/snoozed');
    const row = rows(page).filter({ hasText: title });
    await expect(row.getByTestId('row-why')).toHaveText('You snoozed this to: read the design doc first');
    const r = (await row.boundingBox())!;
    const t = (await row.getByTestId('row-why').boundingBox())!;
    expect(t.x + t.width).toBeLessThanOrEqual(r.x + r.width);
    await shot(page, 'phone-snoozed-why');
  });

  test('choosing a time with no reason is still one tap', async ({ page }) => {
    await openGithub(page);
    const target = withTurn(page, 'them').first();
    const title = (await target.getByTestId('row-title').innerText()).trim();
    await target.getByTestId('row-snooze').tap();
    await page.getByTestId('snooze-tomorrow').tap();
    await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until' })).toBeVisible();
    await expect(rows(page).filter({ hasText: title })).toHaveCount(0);
  });

  test('the Notes list fits the screen, and its controls are big enough to hit', async ({ page }) => {
    await page.goto('/inbox?feed=1');
    await expect(rows(page).first()).toBeVisible();
    await rows(page).first().tap();
    await page.getByTestId('assistant-fab').tap();
    await page.getByTestId('assistant-input').fill('I never want dependabot bumps near the top');
    await page.getByTestId('assistant-send').tap();
    await expect(page.getByText(/^Noted as a standing preference/)).toBeVisible();
    await page.goto('/settings');
    const card = page.getByTestId('settings-notes');
    await card.scrollIntoViewIfNeeded();
    const note = await noteRow(page, 'I never want dependabot');
    await expect(note).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const box = (await note.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    for (const id of ['note-enabled', 'note-delete']) {
      const b = (await note.getByTestId(id).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    const del = (await note.getByTestId('note-delete').boundingBox())!;
    expect(del.height).toBeGreaterThanOrEqual(32);
    await shot(page, 'phone-notes');
    await note.getByTestId('note-delete').tap();
    await expect
      .poll(() => card.getByTestId('note-text').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value)))
      .not.toContain('I never want dependabot bumps near the top');
  });
});
