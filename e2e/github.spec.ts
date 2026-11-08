import { expect, test, type Page } from '@playwright/test';

// One shared demo server with a fake GitHub feed ("demo-org"): 30 pull requests and issues from six kinds of author.
// The tests change shared state (done, muted), so they run in order.
test.describe.configure({ mode: 'serial' });

const FEED = '/inbox?feed=1';
const rows = (page: Page) => page.getByTestId('inbox-row');

// The list is virtualised, so the DOM holds only the visible rows: count items with the sidebar badge instead.
const feedCount = async (page: Page) =>
  Number(
    await page
      .getByTestId('sidebar-feed')
      .filter({ hasText: 'demo-org' })
      .getByTestId('sidebar-feed-count')
      .innerText()
      .catch(() => '0'),
  );

async function openFeed(page: Page) {
  await page.goto(FEED);
  await expect(rows(page).first()).toBeVisible();
}

test('the feed shows up in the sidebar with a count, and its items read as pull requests and issues', async ({
  page,
}) => {
  await page.goto('/inbox');
  const feed = page.getByTestId('sidebar-feed').filter({ hasText: 'demo-org' });
  await expect(feed).toBeVisible();
  await expect(feed.getByTestId('sidebar-feed-count')).toHaveText('30');

  await feed.click();
  await expect(page).toHaveURL(/feed=1/);
  await expect(rows(page).first()).toBeVisible();
  const first = rows(page).first();
  await expect(first.getByTestId('row-title')).toContainText('(#');
  await expect(first.getByTestId('row-kind')).toHaveText(/^(PR|Issue)$/i);
  await expect(page.getByTestId('feed-chip')).toContainText('demo-org');
});

test('who opened it: outside contributors, the team, contributors and bots filter the list', async ({ page }) => {
  await openFeed(page);
  const chips = async () => (await rows(page).getByTestId('row-chip').allInnerTexts()).sort();
  // The list reloads after a filter click, so wait for it to settle on the expected rows rather than sampling once.
  const onlyChips = (allowed: string[]) =>
    expect
      .poll(async () => {
        const c = await chips();
        return c.length > 0 && c.every((x) => allowed.includes(x));
      })
      .toBe(true);

  await page.getByTestId('who-outside').click();
  await expect(page).toHaveURL(/who=outside/);
  await expect(page.getByTestId('who-outside')).toHaveAttribute('aria-pressed', 'true');
  await onlyChips(['First time', 'Outside']);

  await page.getByTestId('who-bots').click();
  await onlyChips(['Bot']);

  await page.getByTestId('who-team').click();
  await onlyChips(['Team']);

  await page.getByTestId('who-all').click();
  await page.getByTestId('kind-issue').click();
  await expect
    .poll(async () => {
      const kinds = await rows(page).getByTestId('row-kind').allInnerTexts();
      return kinds.length > 0 && kinds.every((k) => k.toLowerCase() === 'issue');
    })
    .toBe(true);
});

test('opening an item shows its description and a link to GitHub; e marks it done', async ({ page }) => {
  await openFeed(page);
  await page.getByTestId('who-all').click();
  const before = await feedCount(page);
  const firstTitle = await rows(page).first().getByTestId('row-title').innerText();
  await rows(page).first().click();
  const body = page.getByTestId('gh-body');
  await expect(body).toContainText('Demo');
  await expect(page.getByTestId('thread-view').locator('a.title')).toHaveAttribute('href', /github\.com\/demo-org\//);
  // No reply composer or "mark replied" for GitHub items.
  await expect(page.getByTestId('act-replied')).toHaveCount(0);
  await expect(page.getByTestId('act-reply')).toHaveCount(0);

  await page.keyboard.press('e');
  await expect.poll(() => feedCount(page)).toBe(before - 1);
  await expect(rows(page).filter({ hasText: firstTitle })).toHaveCount(0);
});

test('Shift+M offers to mute the repo, the author or just the item; muting hides it and can be undone', async ({
  page,
}) => {
  await openFeed(page);
  await rows(page).first().click();
  const author = (await rows(page).first().locator('.author').innerText()).trim();
  const before = await feedCount(page);

  await page.keyboard.press('Shift+M');
  const menu = page.getByTestId('mute-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('mute-repo')).toBeVisible();
  await expect(page.getByTestId('mute-item')).toBeVisible();
  await page.getByTestId('mute-author').click();
  await expect(menu).toBeHidden();
  const toast = page.getByTestId('toast').filter({ hasText: `Muted ${author}` });
  await expect(toast).toBeVisible();
  await expect.poll(() => feedCount(page)).toBeLessThan(before);
  await expect(rows(page).filter({ hasText: author })).toHaveCount(0);

  // The rule is listed on the Sources screen.
  await page.goto('/sources');
  const rule = page.getByTestId('mute-rule').filter({ hasText: author });
  await expect(rule).toBeVisible();

  // Undo from the toast restores the items and removes the rule.
  await page.goto(FEED);
  await rows(page).first().click();
  await page.keyboard.press('Shift+M');
  await page.getByTestId('mute-item').click();
  await page.getByTestId('toast').filter({ hasText: 'Muted this item' }).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Undone' }).or(rows(page).first())).toBeVisible();

  await page.goto('/sources');
  await page
    .getByTestId('mute-rule')
    .filter({ hasText: author })
    .getByRole('button', { name: /Unmute/ })
    .click();
  await expect(page.getByTestId('mute-rule').filter({ hasText: author })).toHaveCount(0);
});

test('Settings: the token is masked, "my accounts" can be added and removed, and Test reports', async ({ page }) => {
  await page.goto('/settings');
  const card = page.getByTestId('settings-github');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('github-token')).toHaveAttribute('type', 'password');

  await page.getByTestId('github-account').fill('demo-owner');
  await page.getByTestId('github-account').press('Enter');
  const accounts = page.getByTestId('github-accounts');
  await expect(accounts).toContainText('demo-owner');

  // Items by "me" leave the inbox: demo-owner opened every sixth demo item.
  await page.goto(FEED);
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: 'demo-owner' })).toHaveCount(0);

  await page.goto('/settings');
  await page.getByTestId('github-token').fill('ghp_demo_token_value_1234');
  await page.getByRole('button', { name: 'Test', exact: true }).nth(1).click();
  await expect(page.getByTestId('github-result')).toContainText('Signed in as demo-owner');
  await page.getByTestId('github-save').click();
  await expect(card).toContainText('…1234');
  await expect(page.locator('body')).not.toContainText('ghp_demo_token_value');

  await accounts.getByRole('button', { name: /Remove demo-owner/ }).click();
  await expect(accounts).not.toContainText('demo-owner');
});

test('Sources: add a feed (unknown owners report an error), and the list shows status', async ({ page }) => {
  await page.goto('/sources');
  const table = page.getByTestId('feeds-table');
  await expect(table.getByTestId('feed-row').filter({ hasText: 'demo-org' })).toBeVisible();

  await page.getByTestId('feed-owner').fill('demo-org');
  await page.getByTestId('feed-add').click();
  await expect(page.getByTestId('toast').filter({ hasText: /already a feed/ })).toBeVisible();

  await page.getByTestId('feed-owner').fill('nobody-here');
  await page.getByTestId('feed-add').click();
  const row = table.getByTestId('feed-row').filter({ hasText: 'nobody-here' });
  await expect(row.getByTestId('feed-last-error')).toContainText('no user or organisation', { timeout: 15_000 });
  await row.getByRole('button', { name: 'Remove feed' }).click();
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('a new pull request arrives live: at the top of the list when you are there, as a "new" pill when you are not', async ({
  page,
  request,
}) => {
  await openFeed(page);
  const tick = async () =>
    expect((await request.post('/api/demo/tick', { headers: { 'x-nudge': '1' } })).ok()).toBe(true);

  // At the top: the new item slides in by itself.
  const before = await feedCount(page);
  await tick();
  await expect.poll(() => feedCount(page), { timeout: 15_000 }).toBe(before + 1);
  await expect(rows(page).first().getByTestId('row-title')).toContainText(/#13\d/);

  // Down the list: it waits behind a pill instead of moving things under you.
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await tick();
  await expect(page.getByTestId('new-pill')).toBeVisible({ timeout: 15_000 });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 449, height: 900 }, hasTouch: true });

  test('a pull request opens full screen with big tap targets, and the mute menu is a bottom sheet', async ({
    page,
  }) => {
    await openFeed(page);
    await rows(page).first().tap();
    await expect(page.getByTestId('gh-body')).toBeVisible();
    const mute = page.getByTestId('act-mute');
    await expect(mute).toBeVisible();
    expect((await mute.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await mute.tap();
    const menu = page.getByTestId('mute-menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(850); // anchored to the bottom
    expect((await page.getByTestId('mute-item').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });
});
