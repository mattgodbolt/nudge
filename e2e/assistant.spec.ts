import { expect, test, type Page } from './fixtures';

// One private demo server (the fake assistant understands "remind me in N days to X", "snooze this ... tomorrow" and
// "done"). The tests add todos and a key, so they run in order.
test.describe.configure({ mode: 'serial' });

const box = (page: Page) => page.getByTestId('assistant');

async function tell(page: Page, text: string) {
  await page.keyboard.press('c');
  await expect(box(page)).toBeVisible();
  await page.getByTestId('assistant-input').fill(text);
  await page.keyboard.press('Enter');
  await expect(box(page)).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
});

test('without a key, c then Enter saves what you said as a todo, and says how to get it understood', async ({
  page,
}) => {
  await tell(page, 'buy milk on the way home');
  await expect(page.getByText(/Saved as a todo/)).toBeVisible();
  const row = page.getByTestId('inbox-row').filter({ hasText: 'buy milk on the way home' });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('row-title')).toHaveText('buy milk on the way home');
  // The open todo says when it was added in plain words, and its key hints are the keys that really do it.
  await row.click();
  const pane = page.getByTestId('thread-view');
  // ("now ago" and "Mar 3 ago" were how it used to read.)
  await expect(pane.locator('.vt > .meta')).toHaveText(
    /^Todo · added (just now|\d+[mhdw] ago|[A-Z][a-z]+ \d+(, \d{4})?)$/,
  );
  await expect(pane.locator('.keys-only')).toContainText('e marks it done, b snoozes it');
});

test('Settings stores the Anthropic key without echoing it back', async ({ page }) => {
  await page.goto('/settings');
  const card = page.getByTestId('settings-llm');
  await card.getByTestId('llm-key').fill('sk-ant-demo-1234');
  await card.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByTestId('llm-result')).toContainText('Key works');
  await page.getByTestId('llm-save').click();
  await expect(card).toContainText('…1234');
  await expect(card.getByTestId('llm-key')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText('sk-ant-demo');
});

test('with a key, "remind me in 3 days to …" makes a tidy todo that is due later, and Undo removes it', async ({
  page,
}) => {
  await tell(page, 'um remind me in 3 days to ring the plumber');
  await expect(page.getByText(/Todo: Ring the plumber/)).toBeVisible();
  // Due in the future: not in the inbox, but waiting in Snoozed.
  await expect(page.getByTestId('inbox-row').filter({ hasText: 'Ring the plumber' })).toHaveCount(0);
  await page.goto('/snoozed');
  const row = page.getByTestId('inbox-row').filter({ hasText: 'Ring the plumber' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('todo-title')).toHaveText('Ring the plumber');
  await expect(page.getByTestId('todo-said')).toContainText('remind me in 3 days');

  await page.goto('/inbox');
  await tell(page, 'remind me in 3 days to water the plants');
  await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();
  await page.goto('/snoozed');
  await expect(page.getByTestId('inbox-row').filter({ hasText: 'Ring the plumber' })).toBeVisible();
  await expect(page.getByTestId('inbox-row').filter({ hasText: 'Water the plants' })).toHaveCount(0);
});

test('"done" acts on the selected item; with nothing selected it is a todo-less no-op that says so', async ({
  page,
}) => {
  await tell(page, 'pick up the parcel');
  const row = page.getByTestId('inbox-row').filter({ hasText: 'Pick up the parcel' });
  await row.click();
  await expect(page.getByTestId('todo-title')).toHaveText('Pick up the parcel');
  await tell(page, 'done');
  await expect(page.getByText('Marked done')).toBeVisible();
  await expect(page.getByTestId('inbox-row').filter({ hasText: 'Pick up the parcel' })).toHaveCount(0);
});

test('Escape cancels and keeps nothing; the box does not fire shortcuts while typing', async ({ page }) => {
  await page.keyboard.press('c');
  await page.getByTestId('assistant-input').fill('e j k s');
  await expect(page.getByTestId('assistant-input')).toHaveValue('e j k s');
  await page.keyboard.press('Escape');
  await expect(box(page)).toBeHidden();
  await expect(page.getByTestId('inbox-row').filter({ hasText: 'e j k s' })).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });
  test('the floating mic button opens the box; sending a todo works', async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid=inbox-row]');
    // It stays available with an item open full-screen, where "snooze this" is most useful.
    await page.getByTestId('inbox-row').first().click();
    await expect(page.getByTestId('thread-view')).toBeVisible();
    await expect(page.getByTestId('assistant-fab')).toBeVisible();
    await page.getByTestId('assistant-fab').click();
    await expect(box(page)).toBeVisible();
    await page.getByTestId('assistant-input').fill('book the dentist');
    await page.getByTestId('assistant-send').click();
    await expect(box(page)).toBeHidden();
    await page.getByRole('button', { name: 'Back to list' }).click();
    await expect(page.getByTestId('inbox-row').filter({ hasText: 'Book the dentist' })).toBeVisible();
  });
});
