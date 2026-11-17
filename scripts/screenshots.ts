// Retakes the screenshots in docs/screenshots/ (used by the README and docs/) from a running demo server, in light mode.
//
//   npm run build && NUDGE_DEMO=1 NUDGE_DEMO_SUGGEST=1 NUDGE_DEMO_HISTORY=1 NUDGE_DEMO_GITHUB=1 NUDGE_DEMO_COMMENTS=1 \
//     NUDGE_DB=:memory: NUDGE_PORT=4690 npx tsx server/index.ts &
//   npm run shots -- http://127.0.0.1:4690 [out-dir] [name ...]
//
// Pick a port of your own if e2e runs share the machine (the e2e servers sit at 4600 and up plus E2E_PORT_OFFSET).
// Names (e.g. `hall-of-heroes`) retake only those shots; none retakes them all.
//
// The demo with history (as `npm run demo` has) is what makes the inbox look lived-in: varied ages, suggestions, an
// Adventure level, Insights. Give it a few seconds after starting to seed that history.
//
// The small "closer look" shots are cropped to the interesting part at their natural size (about 650-800px wide) and,
// when ImageMagick is installed, reduced to a 256-colour palette, which keeps each one well under 100 KB.
import { execFileSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4690';
const out = process.argv[3] ?? 'docs/screenshots';
const only = new Set(process.argv.slice(4));
const wanted = (name: string) => only.size === 0 || only.has(name);

const rows = (page: Page) => page.getByTestId('inbox-row');

/** Opens the inbox, clean of toasts. */
async function openInbox(page: Page, query = ''): Promise<void> {
  await page.goto(`${base}/inbox${query}`);
  await rows(page).first().waitFor();
  await dismissToasts(page);
}

/** The first YouTube row whose suggestion says it asks a question: a comment worth replying to. */
const question = (page: Page) => rows(page).filter({ hasText: 'asks a direct question' }).first();

type Box = { x: number; y: number; width: number; height: number };

/** The smallest box holding all of these, grown by `pad` and kept inside the viewport. */
async function around(page: Page, parts: Locator[], pad = 16): Promise<Box> {
  const boxes = (await Promise.all(parts.map((l) => l.boundingBox()))).filter((b): b is Box => b !== null);
  if (boxes.length === 0) throw new Error('nothing to frame');
  const view = page.viewportSize() ?? { width: 1280, height: 860 };
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(view.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
}

/** Scrolls the element to just under the demo banner, whichever container scrolls it. */
async function scrollToTop(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    let p = el.parentElement;
    while (
      p &&
      !(
        p.scrollHeight > p.clientHeight &&
        /auto|scroll/.test(el.ownerDocument.defaultView.getComputedStyle(p).overflowY)
      )
    ) {
      p = p.parentElement;
    }
    if (!p) return;
    // Instant, not smooth: a smooth scroll still running would move things after they were measured.
    const top = p.scrollTop + el.getBoundingClientRect().top - p.getBoundingClientRect().top - 24;
    p.scrollTo({ top, behavior: 'instant' });
  });
  await target.page().waitForTimeout(300);
}

/** Saves a cropped shot as a palette PNG when ImageMagick is there to make one, or as it came otherwise. */
async function smallShot(page: Page, name: string, clip: Box): Promise<void> {
  const path = `${out}/${name}.png`;
  const raw = `${out}/${name}.raw.png`;
  await page.screenshot({ path: raw, clip });
  try {
    execFileSync('magick', [raw, '-strip', '-dither', 'None', '-colors', '256', `PNG8:${path}`]);
    rmSync(raw);
  } catch {
    console.warn(`magick not available: ${path} is unoptimised`);
    renameSync(raw, path);
  }
}

/** The "closer look" gallery in the README: one feature each, cropped small. */
async function closerLook(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 800 }, colorScheme: 'light' });
  const page = await ctx.newPage();

  if (wanted('insights')) {
    await page.goto(`${base}/stats`);
    const heatmap = page.getByTestId('heatmap').first();
    await heatmap.waitFor();
    await dismissToasts(page);
    await scrollToTop(page.getByTestId('insights-section'));
    await smallShot(
      page,
      'insights',
      await around(
        page,
        [
          page.getByTestId('insights-section').getByRole('heading', { name: 'Insights' }),
          page.getByTestId('insights-range-all'),
          heatmap.locator('xpath=ancestor::*[contains(@class,"panel")][1]'),
        ],
        8,
      ),
    );
  }

  if (wanted('hall-of-heroes')) {
    await page.goto(`${base}/stats`);
    const hall = page.getByTestId('hall');
    await hall.getByTestId('hall-title').waitFor();
    await dismissToasts(page);
    // The boss trophies and the title picker sit between the hero and the tiered achievements; leaving them out of
    // this one picture gets both of those into a small frame.
    await hall.evaluate((el) => {
      for (const hide of el.querySelectorAll('.picker, .bosses, h3:first-of-type')) hide.style.display = 'none';
    });
    await scrollToTop(hall);
    // Down to the end of the third row of achievements, where the tiered ones have started.
    const top = await around(page, [hall]);
    const end = await around(page, [hall.getByTestId('hall-achievement').nth(8)], 6);
    await smallShot(page, 'hall-of-heroes', { ...top, height: end.y + end.height - top.y });
  }

  if (wanted('snooze-menu')) {
    await openInbox(page, '?feed=1');
    await rows(page).filter({ hasText: 'PR' }).first().click();
    await page.waitForTimeout(500);
    await page.keyboard.press('b');
    const menu = page.getByTestId('snooze-menu');
    await menu.waitFor();
    // Pick a reason and point at "Until activity", without choosing it: choosing would snooze the item.
    await page.keyboard.press('w');
    await menu.getByTestId('snooze-activity').hover();
    await page.waitForTimeout(400);
    await smallShot(page, 'snooze-menu', await around(page, [menu], 40));
    await page.keyboard.press('Escape');
  }

  if (wanted('command-palette')) {
    await openInbox(page);
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('palette');
    await palette.waitFor();
    await page.keyboard.type('sn');
    await page.waitForTimeout(400);
    await smallShot(page, 'command-palette', await around(page, [palette], 40));
    await page.keyboard.press('Escape');
  }

  if (wanted('settings')) {
    await page.goto(`${base}/settings`);
    const about = page.getByTestId('settings-about');
    await about.waitFor();
    await dismissToasts(page);
    await smallShot(
      page,
      'settings',
      await around(page, [page.getByRole('heading', { name: 'Settings', level: 1 }), about], 12),
    );
  }

  if (wanted('github-conversation')) {
    await ctx.close();
    const wide = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
    const p = await wide.newPage();
    await openInbox(p, '?feed=1');
    await rows(p).filter({ hasText: 'PR' }).first().click();
    const thread = p.getByTestId('thread-view');
    await thread.getByText('Conversation').first().waitFor({ timeout: 15_000 });
    await p.waitForTimeout(1_000);
    // From the title down to the third comment of the conversation: the one requesting changes.
    const box = await around(p, [thread], 0);
    const end = await around(p, [thread.getByTestId('gh-entry').nth(2)], 12);
    await smallShot(p, 'github-conversation', { ...box, height: end.y + end.height - box.y });
    await wide.close();
  } else {
    await ctx.close();
  }
}

/** Lets the page settle and clears any toast (the Adventure greeting) so it is not in the picture. */
async function dismissToasts(page: Page): Promise<void> {
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

async function main(): Promise<void> {
  const browser = await chromium.launch();
  await closerLook(browser);
  // These four are taken together: the reply shot follows on from the inbox one.
  if (!['phone-inbox', 'inbox', 'youtube-reply', 'github-thread'].some(wanted)) {
    await browser.close();
    return;
  }
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
  await page
    .getByTestId('composer')
    .fill('Thanks! The code is linked in the description, and in the online playground.');
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
