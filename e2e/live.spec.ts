import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Live updates from the server reaching a page that is mid-list or reading a thread. Changes are made "elsewhere"
// (another device) through the API, which the page hears about over its event stream. Its own demo server, since
// every test finishes items; serial, so one test's changes cannot land in another's page.
test.describe.configure({ mode: 'serial' });

const H = { 'x-nudge': '1' };

interface Row {
  comment: { id: string; threadId: string };
  item: { provider: string };
  threadReplyCount: number;
}

async function inboxRows(request: APIRequestContext): Promise<Row[]> {
  return ((await (await request.get('/api/inbox?view=inbox&limit=100')).json()) as { items: Row[] }).items;
}
async function finishElsewhere(request: APIRequestContext, ...ids: string[]) {
  expect((await request.post('/api/triage', { headers: H, data: { commentIds: ids, to: 'done' } })).ok()).toBe(true);
}
const row = (page: Page, id: string) => page.locator(`[data-testid=inbox-row][data-comment-id="${id}"]`);
const cursorId = (page: Page) =>
  page.locator('[data-testid=inbox-row][aria-selected=true]').getAttribute('data-comment-id');

test('an item finished on another device leaves the list even when the cursor is not on the first row', async ({
  page,
  request,
}) => {
  // The order from the API, which is the page's order (the list is virtualised, so the DOM's need not be).
  const order = (await inboxRows(request)).map((r) => r.comment.id);
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  const cursor = order[3]!;
  await expect.poll(() => cursorId(page)).toBe(cursor);

  await finishElsewhere(request, order[1]!);
  await finishElsewhere(request, order[5]!);
  await expect(row(page, order[1]!)).toHaveCount(0);
  await expect(row(page, order[5]!)).toHaveCount(0);
  // The cursor stays on the row it was on.
  expect(await cursorId(page)).toBe(cursor);

  // And when it is the cursor's own row that is finished elsewhere, the cursor moves to the next one.
  await finishElsewhere(request, cursor);
  await expect(row(page, cursor)).toHaveCount(0);
  await expect.poll(() => cursorId(page)).toBe(order[4]);
});

test('the open thread stays on screen, where it was scrolled to, while live updates arrive', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const rows = await inboxRows(request);
  // The YouTube comment with the longest thread on the first page, so there is something to scroll.
  const open = rows
    .filter((r) => r.item.provider === 'youtube')
    .sort((a, b) => b.threadReplyCount - a.threadReplyCount)[0]!;
  expect(open.threadReplyCount).toBeGreaterThan(3);
  // Make it the first row: that is where a live update used to refresh the list and, with it, blank the thread.
  const at = rows.indexOf(open);
  if (at > 0) await finishElsewhere(request, ...rows.slice(0, at).map((r) => r.comment.id));
  await page.goto(`/inbox?c=${encodeURIComponent(open.comment.id)}`);
  await expect(page.getByTestId('inbox-row').first()).toHaveAttribute('data-comment-id', open.comment.id);
  const pane = page.getByTestId('thread-view');
  const scroller = pane.locator('.scroll');
  await expect(pane.locator('.scroll [data-comment-id]').nth(2)).toBeVisible();
  // Scroll away from where it opened.
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrolled = await scroller.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  // Note any moment the thread goes blank (its loading placeholder), and count its refetches.
  await page.evaluate(() => {
    const w = window as unknown as { __blanked?: boolean };
    w.__blanked = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid=thread-view] .skeleton')) w.__blanked = true;
    }).observe(document.body, { subtree: true, childList: true });
  });
  let refetches = 0;
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === `/api/threads/${encodeURIComponent(open.comment.threadId)}`) refetches++;
  });

  // Two changes elsewhere.
  for (const other of rows.slice(at + 1, at + 3)) {
    const before = refetches;
    await finishElsewhere(request, other.comment.id);
    await expect(row(page, other.comment.id)).toHaveCount(0);
    // The open thread is brought up to date too (it may have changed), behind the scenes.
    await expect.poll(() => refetches).toBeGreaterThan(before);
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200))));
  expect(await page.evaluate(() => (window as unknown as { __blanked?: boolean }).__blanked)).toBe(false);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);
});
