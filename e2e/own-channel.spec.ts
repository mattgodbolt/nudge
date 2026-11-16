import { expect, test } from './fixtures';

// The second test starts from where the first leaves the demo server (one channel marked as mine), so they run in order.
test.describe.configure({ mode: 'serial' });

test('adding my channel from Settings by @handle shows its title and marks the source as mine', async ({ page }) => {
  await page.goto('/settings');
  const chips = page.getByTestId('own-channel-chip');
  await expect(chips).toHaveCount(1); // the demo seed
  await chips.first().getByRole('button').click();
  await expect(chips).toHaveCount(0);

  // Un-marking keeps the channel tracked, but no longer flags it as mine.
  await page.goto('/sources');
  await expect(page.getByTestId('own-badge')).toHaveCount(0);
  await expect(page.getByTestId('sources-table')).not.toContainText('Mine');

  await page.goto('/settings');
  await page.getByTestId('own-channel-input').fill('https://www.youtube.com/@demochannel');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).not.toContainText('UCdemo'); // title, not the bare id

  await page.goto('/sources');
  await expect(page.getByTestId('own-badge')).toHaveCount(1);
  await expect(page.getByRole('columnheader', { name: 'Mine' })).toHaveCount(0);
});

test('an unknown handle shows an error and adds nothing', async ({ page }) => {
  await page.goto('/settings');
  // Settings fills in after the page loads: counting straight away read 0 and then saw the real chip arrive.
  await expect(page.getByTestId('own-channel-chip')).toHaveCount(1);
  const before = 1;
  await page.getByTestId('own-channel-input').fill('@nosuchchannelanywhere');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/not found/i);
  await expect(page.getByTestId('own-channel-chip')).toHaveCount(before);
});
