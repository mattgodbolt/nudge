import { expect, test, type Page } from './fixtures';

// Runs against the demo server started with NUDGE_DEMO_POST=api (see playwright.config.ts, port 4519).
// The tests share that server's in-memory state, so they run in order.
test.describe.configure({ mode: 'serial' });

const countOf = async (page: Page) =>
  Number((await page.getByTestId('sidebar-count-inbox').innerText()).replace(/\D/g, ''));

test.beforeEach(async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
});

test('composer posts as the connected channel; reply shows as own; z moves only the target back', async ({ page }) => {
  const before = await countOf(page);
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer-box')).toContainText('post as Demo Channel');
  const text = `Posted from e2e ${Date.now()}`;
  await page.keyboard.type(text);
  await page.keyboard.press('Control+Enter');

  await expect(page.getByTestId('toast').filter({ hasText: 'Reply posted' })).toBeVisible();
  await expect(page.getByTestId('toast').filter({ hasText: 'Demo Channel' })).toBeVisible();
  // The target leaves the inbox...
  await expect.poll(() => countOf(page)).toBeLessThan(before);
  const afterPost = await countOf(page);

  // ...and z moves back just the target (older comments auto-cleared by our reply stay cleared), keeping the reply.
  await page.keyboard.press('z');
  await expect.poll(() => countOf(page)).toBe(afterPost + 1);
  const own = page.locator('[data-testid=thread-view] .card.own', { hasText: text });
  await expect(own).toHaveCount(1);
});

test('a failed post shows the error and keeps the draft', async ({ page }) => {
  const before = await countOf(page);
  await page.keyboard.press('r');
  await page.keyboard.press('Control+a'); // the composer may be pre-filled with an @mention or an earlier draft
  await page.keyboard.type('Please fail [[fail:quota]]');
  await page.keyboard.press('Control+Enter');

  await expect(page.getByTestId('toast').filter({ hasText: /quota/i }).first()).toBeVisible();
  await expect.poll(() => countOf(page)).toBe(before); // rolled back
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer')).toHaveValue(/^Please fail \[\[fail:quota\]\]$/);
});

test('Settings shows the connection; Disconnect switches the composer back to Copy & open', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-google')).toContainText('Demo Channel');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('settings-google')).not.toContainText('Demo Channel');

  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
  await page.keyboard.press('r');
  await expect(page.getByTestId('composer-send')).toHaveText(/Copy & open/);
});
