import { expect, test, type Page } from './fixtures';

// Read-only checks of the Settings layout on the shared demo server (the YouTube key comes from the environment there,
// one channel is marked as mine, and no Anthropic key is set). Flows that change settings live with their features.

async function open(page: Page) {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-version')).toBeVisible();
}

test('four groups in order, each card under its group, with nothing left to finish', async ({ page }) => {
  await open(page);
  const outline = await page
    .locator('.page')
    .locator('h1, h2, h3')
    .evaluateAll((els) => els.map((e) => `${e.tagName} ${e.textContent!.trim()}`));
  expect(outline).toEqual([
    'H1 Settings',
    'H2 You',
    'H3 About you',
    'H3 My channels',
    'H3 My GitHub accounts',
    'H2 Preferences',
    'H3 Appearance',
    'H3 Suggestions',
    'H3 Notes',
    'H3 Snoozing until activity',
    'H3 On this device',
    'H3 Adventure mode',
    'H2 Connections',
    'H3 YouTube API key',
    'H3 Assistant: Anthropic API key',
    'H3 GitHub token',
    'H3 Post replies from Nudge',
    'H2 Sync and data',
    'H3 Syncing',
    'H3 Usage data',
    'H3 Version',
  ]);
  // The demo has a channel and no Anthropic key, so nothing blocks: no "Finish setting up".
  await expect(page.getByTestId('profile-banner')).toHaveCount(0);
  // Without a key, the cards that need one say where it goes.
  await expect(page.getByTestId('about-needs-key')).toContainText('Connections › Assistant');
});

test('the links under the heading go to their group', async ({ page }) => {
  await open(page);
  const toc = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(toc.getByRole('link')).toHaveText(['You', 'Preferences', 'Connections', 'Sync and data']);
  for (const [name, id] of [
    ['Sync and data', 'sync'],
    ['Connections', 'connections'],
    ['Preferences', 'preferences'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`/settings#${id}$`));
    await expect(page.locator(`#${id} h2`)).toBeInViewport();
  }
});

test('opening Settings at a section lands on it', async ({ page }) => {
  await page.goto('/settings#reply');
  await expect(page.getByTestId('settings-google')).toBeInViewport();
  await expect(page.getByTestId('settings-about')).not.toBeInViewport();
});

test('a key from the environment is a status line with Test only, and Test reports', async ({ page }) => {
  await open(page);
  const card = page.getByTestId('settings-key');
  await expect(card.getByTestId('key-status')).toContainText('from the YOUTUBE_API_KEY environment variable');
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveText(['Test']);
  await card.getByRole('button', { name: 'Test' }).click();
  await expect(card).toContainText('Demo mode');
});

test('text areas are as tall as their rows, not one line', async ({ page }) => {
  await open(page);
  const about = await page.getByTestId('owner-about').boundingBox();
  const name = await page.getByTestId('owner-name').boundingBox();
  // rows=4: several lines, where the fixed control height had held it to one.
  expect(about!.height).toBeGreaterThan(name!.height * 2.5);
});

test('a disabled Save does not look like the primary action', async ({ page }) => {
  await open(page);
  const save = page.getByTestId('owner-save');
  await expect(save).toBeDisabled();
  const [bg, accent] = await save.evaluate((el) => [
    getComputedStyle(el).backgroundColor,
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  ]);
  expect(bg).not.toBe('rgb(220, 38, 38)');
  expect(accent).toBeTruthy();
});

test('a chip remove button is a 32px target on a desktop, without making the chip taller', async ({ page }) => {
  await open(page);
  const chip = page.getByTestId('own-channel-chip');
  const x = (await chip.getByRole('button').boundingBox())!;
  expect(Math.min(x.width, x.height)).toBeGreaterThanOrEqual(32);
  expect((await chip.boundingBox())!.height).toBeLessThan(32);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  for (const scheme of ['light', 'dark'] as const) {
    test(`nothing scrolls sideways (${scheme}), and inputs in a row get the whole width`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const widths = await page.evaluate(() => {
        const p = document.querySelector('.page')!;
        return { doc: document.documentElement.scrollWidth, page: p.scrollWidth, client: p.clientWidth };
      });
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.page).toBeLessThanOrEqual(widths.client);
      // The add-channel box is not squeezed beside its button.
      const input = (await page.getByTestId('own-channel-input').boundingBox())!;
      const card = (await page.getByTestId('settings-channels').boundingBox())!;
      expect(input.width).toBeGreaterThan(card.width * 0.8);
      // A chip's remove button is big enough for a finger.
      const x = (await page.getByTestId('own-channel-chip').getByRole('button').boundingBox())!;
      expect(Math.min(x.width, x.height)).toBeGreaterThanOrEqual(32);
    });
  }
});
