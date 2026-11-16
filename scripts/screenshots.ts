// Retakes the README screenshots in docs/screenshots/ from a running demo server, in light mode.
//
//   npm run build && NUDGE_DEMO=1 NUDGE_DEMO_SUGGEST=1 NUDGE_DEMO_HISTORY=1 NUDGE_DEMO_GITHUB=1 NUDGE_DEMO_COMMENTS=1 \
//     NUDGE_DB=:memory: NUDGE_PORT=4690 npx tsx server/index.ts &
//   npm run shots -- http://127.0.0.1:4690
//
// The demo with history (as `npm run demo` has) is what makes the inbox look lived-in: varied ages, suggestions, an
// Adventure level. Give it a few seconds after starting to seed that history.
import { chromium, type Page } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4690';
const out = process.argv[3] ?? 'docs/screenshots';

const rows = (page: Page) => page.getByTestId('inbox-row');

/** Opens the inbox, lets it settle and clears any toast (the Adventure greeting) so it is not in the picture. */
async function openInbox(page: Page, query = ''): Promise<void> {
  await page.goto(`${base}/inbox${query}`);
  await rows(page).first().waitFor();
  await page.waitForTimeout(1_000);
  for (const close of await page.getByTestId('toast').getByRole('button', { name: 'Dismiss' }).all()) {
    await close.click().catch(() => {});
  }
  await page
    .getByTestId('toast')
    .first()
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => {});
}

/** The first YouTube row whose suggestion says it asks a question: a comment worth replying to. */
const question = (page: Page) => rows(page).filter({ hasText: 'asks a direct question' }).first();

async function main(): Promise<void> {
  const browser = await chromium.launch();
  // The phone first: the desktop shots below leave a reply draft behind, which the phone list would then show.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    hasTouch: true,
    isMobile: true,
  });
  const p = await phone.newPage();
  await openInbox(p);
  await p.screenshot({ path: `${out}/phone-inbox.png` });

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  const page = await desktop.newPage();

  await openInbox(page);
  await question(page).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/inbox.png` });

  await page.keyboard.press('r');
  await page.getByTestId('composer').fill('Thanks! The code is linked in the description, and on Compiler Explorer.');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/youtube-reply.png` });
  await page.keyboard.press('Escape');

  // The demo GitHub organisation is feed 1; its pull requests come with a conversation.
  await openInbox(page, '?feed=1');
  await rows(page).filter({ hasText: 'PR' }).first().click();
  await page
    .getByText('Conversation')
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: `${out}/github-thread.png` });

  await browser.close();
}

await main();
