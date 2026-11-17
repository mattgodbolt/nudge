import { expect, rows, shot as shotAt, test, type Page } from './fixtures';

// One shared demo server with a fake GitHub feed ("demo-org"): 30 pull requests and issues from six kinds of author.
// The tests change shared state (done, muted), so they run in order.
test.describe.configure({ mode: 'serial' });

const FEED = '/inbox?feed=1';

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

test('the sidebar groups YouTube, GitHub and Todos under Sources, and an owner opens out into repos to filter by', async ({
  page,
}) => {
  await page.goto('/inbox');
  const side = page.getByRole('navigation', { name: 'Main' });
  await expect(side.getByText('Sources', { exact: true })).toBeVisible();
  await expect(side.getByText('YouTube', { exact: true })).toBeVisible();
  await expect(side.getByText('GitHub', { exact: true })).toBeVisible();
  await expect(page.getByTestId('sidebar-todos')).toBeVisible();

  await expect(page.getByTestId('sidebar-repo')).toHaveCount(0); // collapsed until opened
  await page.getByTestId('feed-toggle').click();
  const repos = page.getByTestId('sidebar-repo');
  await expect(repos).toHaveCount(3);
  await expect(repos.filter({ hasText: 'compiler' }).getByTestId('sidebar-repo-count')).toBeVisible();

  await repos.filter({ hasText: 'compiler' }).click();
  await expect(page).toHaveURL(/repo=demo-org%2Fcompiler/);
  await expect(page.getByTestId('repo-chip')).toContainText('demo-org/compiler');
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).first()).toContainText('demo-org/compiler #');
  await expect(rows(page).filter({ hasText: 'demo-org/infra #' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Clear repository filter' }).click();
  await expect(page.getByTestId('repo-chip')).toHaveCount(0);
  await page.getByTestId('feed-toggle').click(); // collapse again for the tests that follow
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

test('a pull request shows its conversation: comments, review state, inline context, quiet bots, sanitised', async ({
  page,
}) => {
  await openFeed(page);
  await page.getByTestId('who-all').click();
  await rows(page)
    .filter({ has: page.getByTestId('row-kind').filter({ hasText: /^PR$/i }) })
    .first()
    .click();
  const entries = page.getByTestId('gh-entry');
  await expect(entries).toHaveCount(4);
  await expect(page.getByTestId('gh-review-state')).toHaveText('Changes requested');
  await expect(page.getByTestId('gh-inline-context')).toHaveText('src/parser.cpp:42');
  await expect(entries.first()).toHaveClass(/bot/); // the bot's note is the quiet one
  await expect(entries.nth(1)).not.toHaveClass(/bot/);
  // Strangers' markdown goes through the sanitiser: the script-bearing attribute never reaches the page.
  await expect(page.getByTestId('gh-discussion').locator('[onerror]')).toHaveCount(0);
  // Nothing was newer than a wake-up here, so nothing is marked.
  await expect(page.getByTestId('gh-new')).toHaveCount(0);
  // Replying stays on GitHub, and the shortcuts still work with the conversation on screen.
  await expect(page.getByTestId('act-open')).toBeVisible();
  const title = page.locator('[data-testid=inbox-row][aria-selected=true]').getByTestId('row-title');
  const first = await title.innerText();
  await page.keyboard.press('j');
  await expect.poll(() => title.innerText()).not.toBe(first);
});

test('when the conversation cannot be loaded, the pane keeps the description and says so', async ({ page }) => {
  await page.route('**/api/items/*/discussion', (route) =>
    route.fulfill({
      status: 424,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'GitHub rate limit reached; try again shortly', code: 'github_unavailable' }),
    }),
  );
  await openFeed(page);
  await page.getByTestId('who-all').click();
  await rows(page).first().click();
  await expect(page.getByTestId('gh-discussion-error')).toContainText("Couldn't load the conversation");
  await expect(page.getByTestId('gh-discussion-error').getByRole('link')).toHaveAttribute('href', /github\.com/);
  await expect(page.getByTestId('gh-body')).toContainText('Demo');
  await expect(page.getByTestId('act-done')).toBeVisible();
});

test('opening an item shows its description and a link to GitHub; e marks it done', async ({ page }) => {
  await openFeed(page);
  await page.getByTestId('who-all').click();
  const before = await feedCount(page);
  const firstTitle = await rows(page).first().getByTestId('row-title').innerText();
  await rows(page).first().click();
  const body = page.getByTestId('gh-body');
  await expect(body).toContainText('Demo');
  // The description is rendered markdown: bold text and a collapsed <details>, not visible tags or asterisks.
  await expect(page.getByTestId('gh-markdown').locator('strong')).toHaveText('what changed');
  await expect(page.getByTestId('gh-markdown').locator('summary')).toHaveText('Commits');
  await expect(body).not.toContainText('<details>');
  await expect(body).not.toContainText('**');
  await expect(page.getByTestId('thread-view').locator('a.title')).toHaveAttribute('href', /github\.com\/demo-org\//);
  // No reply composer (you reply on GitHub), but you can say you did.
  await expect(page.getByTestId('act-replied')).toHaveCount(1);
  await expect(page.getByTestId('act-reply')).toHaveCount(0);

  await page.keyboard.press('e');
  await expect.poll(() => feedCount(page)).toBe(before - 1);
  await expect(rows(page).filter({ hasText: firstTitle })).toHaveCount(0);
});

test('m marks a GitHub item replied (you answered it on GitHub) and it leaves the inbox', async ({ page }) => {
  await openFeed(page);
  const before = await feedCount(page);
  const firstTitle = (await rows(page).first().getByTestId('row-title').innerText()).trim();
  await rows(page).first().click();
  await expect(page.getByTestId('thread-view')).toBeVisible();
  await page.keyboard.press('m');
  await expect.poll(() => feedCount(page)).toBe(before - 1);
  await expect(rows(page).filter({ hasText: firstTitle })).toHaveCount(0);
});

test('j and k keep moving through the list after opening an item and after e (no Escape needed)', async ({ page }) => {
  await openFeed(page);
  await page.getByTestId('who-all').click();
  const selected = () => page.locator('[data-testid=inbox-row][aria-selected=true]');
  const title = () => selected().getByTestId('row-title').innerText();

  await rows(page).first().click();
  await expect(page.getByTestId('thread-view')).toBeVisible();
  const first = await title();
  await page.keyboard.press('j');
  await expect.poll(title).not.toBe(first);
  const second = await title();
  await page.keyboard.press('k');
  await expect.poll(title).toBe(first);

  // Mark done, then carry straight on down the list.
  await page.keyboard.press('e');
  await expect.poll(title).not.toBe(first);
  const afterDone = await title();
  await page.keyboard.press('j');
  await expect.poll(title).not.toBe(afterDone);
  expect(second).not.toBe(first);
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
  // Undo is two requests, the last one deleting the rule. Wait for it: leaving the page first can abort it, and the
  // item's mute rule then survives into the next test (it showed up on Sources beside the organisation rule).
  const undone = page.waitForResponse((r) => /\/api\/mutes\/\d+$/.test(r.url()) && r.request().method() === 'DELETE');
  await page.getByTestId('toast').filter({ hasText: 'Muted this item' }).getByRole('button', { name: 'Undo' }).click();
  expect((await undone).ok()).toBe(true);

  await page.goto('/sources');
  await page
    .getByTestId('mute-rule')
    .filter({ hasText: author })
    .getByRole('button', { name: /Unmute/ })
    .click();
  await expect(page.getByTestId('mute-rule').filter({ hasText: author })).toHaveCount(0);
});

test('Shift+M can mute a whole organisation, undoably; the rule reads as an organisation and can be unmuted', async ({
  page,
  request,
}) => {
  await openFeed(page);
  await rows(page).first().click();
  const before = await feedCount(page);
  expect(before).toBeGreaterThan(5);

  await page.keyboard.press('Shift+M');
  await expect(page.getByTestId('mute-owner')).toContainText('Mute all of demo-org');
  await page.getByTestId('mute-owner').click();
  const toast = page.getByTestId('toast').filter({ hasText: 'Muted all of demo-org' });
  await expect(toast).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => feedCount(page)).toBe(before);

  // The same rule from the API, to look at how Sources lists it and that Unmute removes it.
  const H = { 'x-nudge': '1' };
  const muted = (await request.post('/api/mutes', { headers: H, data: { kind: 'owner', value: 'demo-org' } })).json();
  const { rule, triage } = await muted;
  await page.goto('/sources');
  const row = page.getByTestId('mute-rule').filter({ hasText: 'demo-org' });
  await expect(row).toContainText('Organisation');
  await row.getByRole('button', { name: /Unmute/ }).click();
  await expect(row).toHaveCount(0);
  expect(rule.kind).toBe('owner');
  expect((await request.post(`/api/triage/${triage.actionId}/undo`, { headers: H })).ok()).toBe(true);
  await openFeed(page);
  await expect.poll(() => feedCount(page)).toBe(before);
});

test('the mute menu closes, and lets go of the keyboard, when its item is finished elsewhere', async ({
  page,
  request,
}) => {
  await openFeed(page);
  await rows(page).first().click();
  const id = (await rows(page).first().getAttribute('data-comment-id'))!;
  await page.keyboard.press('Shift+M');
  const menu = page.getByTestId('mute-menu');
  await expect(menu).toBeVisible();

  const H = { 'x-nudge': '1' };
  const res = await request.post('/api/triage', { headers: H, data: { commentIds: [id], to: 'done' } });
  const { actionId } = (await res.json()) as { actionId: number };
  await expect(page.locator(`[data-testid=inbox-row][data-comment-id="${id}"]`)).toHaveCount(0);
  await expect(menu).toBeHidden();
  // The keys work again: before, an invisible menu kept them until Escape.
  const selected = () => page.locator('[data-testid=inbox-row][aria-selected=true]').getAttribute('data-comment-id');
  const at = await selected();
  await page.keyboard.press('j');
  await expect.poll(selected).not.toBe(at);

  expect((await request.post(`/api/triage/${actionId}/undo`, { headers: H })).ok()).toBe(true);
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
  await card.getByRole('button', { name: 'Test', exact: true }).click();
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

test.describe('on a phone, the top of the inbox leaves the room to the list', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('nav is one row, filters are one scrolling line, and the list starts near the top', async ({ page }) => {
    await page.goto('/inbox');
    await expect(rows(page).first()).toBeVisible();
    const nav = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
    expect(nav.height).toBeLessThan(64);
    const filters = (await page.getByTestId('gh-filters').boundingBox())!;
    expect(filters.height).toBeLessThan(64);
    // "Who" and "kind" share a line (it scrolls sideways) instead of wrapping onto two.
    const who = (await page.getByTestId('who-all').boundingBox())!;
    const kind = (await page.getByTestId('kind-any').boundingBox())!;
    expect(Math.abs(who.y - kind.y)).toBeLessThan(2);
    expect(who.height).toBeGreaterThanOrEqual(40);
    // Includes the demo banner (about 50px); it used to start at ~370.
    expect((await rows(page).first().boundingBox())!.y).toBeLessThan(260);
    for (const id of ['refresh', 'search-toggle', 'nav-more']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('search hides behind a magnifier; Manage sources, Stats and Settings sit behind the menu button', async ({
    page,
  }) => {
    await page.goto('/inbox');
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByTestId('search')).toBeHidden();
    await page.getByTestId('search-toggle').tap();
    await expect(page.getByTestId('search')).toBeFocused();
    await page.getByTestId('search').fill('zzzz-no-such-thing');
    await expect(page.getByText('Nothing matches')).toBeVisible();
    // Closing the box clears the search, so the list comes back.
    await page.getByTestId('search-toggle').tap();
    await expect(page.getByTestId('search')).toBeHidden();
    await expect(rows(page).first()).toBeVisible();

    await expect(page.getByRole('link', { name: 'Settings' })).toBeHidden();
    await page.getByTestId('nav-more').tap();
    await page.getByRole('link', { name: 'Settings' }).tap();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole('link', { name: 'Settings' })).toBeHidden();
  });
});

// Screenshots for eyeballing the layout are written only when $NUDGE_SHOTS names a directory, as in the other specs.
const shot = (page: Page, name: string) => shotAt(page, name, { fullPage: true });

async function addRepoFeed(page: Page, name: string) {
  await page.goto('/sources');
  await page.getByTestId('feed-owner').fill(name);
  await page.getByTestId('feed-import').selectOption('all');
  await page.getByTestId('feed-add').click();
}

async function removeFeed(page: Page, name: string) {
  const row = page.getByTestId('feeds-table').getByTestId('feed-row').filter({ hasText: name });
  await row.getByRole('button', { name: 'Remove feed' }).click();
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toHaveCount(0);
}

test('Sources: a single repository can be followed on its own, and an unknown one reports an error', async ({
  page,
}) => {
  await page.goto('/sources');
  await expect(page.getByTestId('feed-owner')).toHaveAttribute('placeholder', /owner\/repo/);

  // demo-org is already a whole feed, so one of its repositories adds nothing.
  await page.getByTestId('feed-owner').fill('demo-org/docs');
  await page.getByTestId('feed-add').click();
  await expect(page.getByTestId('toast').filter({ hasText: /already covered by the demo-org feed/ })).toBeVisible();

  await page.getByTestId('feed-owner').fill('quiet-org/nope');
  await page.getByTestId('feed-add').click();
  const missing = page.getByTestId('feeds-table').getByTestId('feed-row').filter({ hasText: 'quiet-org/nope' });
  await expect(missing.getByTestId('feed-last-error')).toContainText('no repository called "quiet-org/nope"', {
    timeout: 15_000,
  });
  await removeFeed(page, 'quiet-org/nope');

  await page.getByTestId('feed-owner').fill('https://github.com/quiet-org/tiny');
  await page.getByTestId('feed-import').selectOption('all');
  await page.getByTestId('feed-add').click();
  const row = page.getByTestId('feeds-table').getByTestId('feed-row').filter({ hasText: 'quiet-org/tiny' });
  await expect(row.getByTestId('feed-kind')).toHaveText('repo');
  await expect(row.getByTestId('feed-last-error')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Poll now' })).toBeVisible();
  await expect(row.locator('td.num').first()).toHaveText('3', { timeout: 15_000 });

  await shot(page, 'repo-feed-desktop');

  // Its items are filed under it, and only its own repository is there.
  const side = page.getByTestId('sidebar-feed').filter({ hasText: 'quiet-org/tiny' });
  await expect(side.getByTestId('sidebar-feed-count')).toHaveText('3');
  await side.click();
  await expect(page.getByTestId('feed-chip')).toContainText('quiet-org/tiny');
  await expect(rows(page).first().getByTestId('row-title')).toContainText('Quiet repository item');

  // On/off and Poll now work as for any feed.
  await page.goto('/sources');
  await row.getByRole('checkbox', { name: 'Enabled' }).uncheck();
  await expect(row).toHaveClass(/off/);
  await row.getByRole('checkbox', { name: 'Enabled' }).check();
  await row.getByRole('button', { name: 'Poll now' }).click();

  // Removing it removes its items, and leaves demo-org alone.
  await removeFeed(page, 'quiet-org/tiny');
  await expect(page.getByTestId('feeds-table').getByTestId('feed-row').filter({ hasText: 'demo-org' })).toBeVisible();
  await expect(side).toHaveCount(0);
});

test.describe('a repository feed on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the form and table fit, and the table scrolls rather than clipping its buttons', async ({ page }) => {
    await addRepoFeed(page, 'quiet-org/tiny');
    const row = page.getByTestId('feeds-table').getByTestId('feed-row').filter({ hasText: 'quiet-org/tiny' });
    await expect(row.getByTestId('feed-kind')).toBeVisible();
    await expect(row.locator('td.num').first()).toHaveText('3', { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const id of ['feed-owner', 'feed-import', 'feed-add']) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    // The table sits in a scrolling wrapper, so the action buttons can be reached.
    const wrap = page.getByTestId('github-feeds').locator('.tablewrap');
    expect(await wrap.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    await row.getByRole('button', { name: 'Poll now' }).scrollIntoViewIfNeeded();
    await shot(page, 'repo-feed-390');
    await removeFeed(page, 'quiet-org/tiny');
  });
});
