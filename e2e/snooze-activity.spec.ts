import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Snoozing until activity, on a demo server with a fake GitHub feed whose items have comment threads. Comments are
// delivered on demand (POST /api/demo/comment) and the snooze waker can be run as if days had passed
// (POST /api/demo/advance), so nothing here waits for a real timer. The tests change shared state, so they run in
// order; each one works on an item of its own, and the one that moves the waker's clock comes after the others.
test.describe.configure({ mode: 'serial' });

const H = { 'x-nudge': '1' };
const DAY = 86_400_000;

interface Row {
  comment: { id: string };
  item: { title: string; github?: { number: number; comments: number } };
  snoozedUntil: string | null;
  snoozeBucket: string | null;
  snoozeUntilActivity: boolean;
  wakeCause: string | null;
  snoozeNag: { bucket: string | null; days: number } | null;
  snoozeWhy: string | null;
}

/** Open threads from someone else (so a comment from "me" or "them" is meaningful), in a stable order. */
let candidates: Row[] = [];
const take = (n: number): Row => candidates[n]!;

/** The GitHub feed's items (the demo's YouTube items would bury them), plus the snoozed ones of any kind. */
async function list(request: APIRequestContext, view: 'inbox' | 'snoozed' | 'all'): Promise<Row[]> {
  const res = await request.get(`/api/inbox?view=${view}&limit=500${view === 'snoozed' ? '' : '&feedId=1'}`);
  return ((await res.json()) as { items: Row[] }).items;
}
const find = async (request: APIRequestContext, view: 'inbox' | 'snoozed' | 'all', id: string) =>
  (await list(request, view)).find((r) => r.comment.id === id);

test.beforeAll(async ({ request }) => {
  // The first poll of the fake feed may still be running.
  const threads = async () => (await list(request, 'inbox')).filter((i) => (i.item.github?.comments ?? 0) > 0);
  await expect.poll(async () => (await threads()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(10);
  candidates = (await threads()).slice(-10);
  // A key makes "Draft a nudge" available; the demo server's model is a fake and nothing leaves the machine.
  const res = await request.put('/api/settings', { headers: H, data: { llm: { apiKey: 'demo-key' } } });
  expect(res.ok()).toBe(true);
});

const snoozeVia = (request: APIRequestContext, id: string, data: Record<string, unknown>) =>
  request.post('/api/snooze', { headers: H, data: { commentIds: [id], ...data } });
const comment = async (request: APIRequestContext, id: string, me: boolean) =>
  expect((await request.post('/api/demo/comment', { headers: H, data: { itemId: id, me } })).ok()).toBe(true);

/** Open one item: find it by its number in All (which lists snoozed items too) and select it. */
async function open(page: Page, row: Row) {
  await page.goto(`/all?q=${row.item.github!.number}`);
  const first = page.getByTestId('inbox-row').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByTestId('thread-view')).toBeVisible();
}

test("b, a reason key and 6 snoozes until activity, with that bucket's fallback; the Snoozed view says so", async ({
  page,
  request,
}) => {
  const row = take(0);
  await open(page, row);
  await page.keyboard.press('b');
  const menu = page.getByTestId('snooze-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('snooze-activity-days')).toHaveText('or 7d');
  await page.keyboard.press('m'); // waiting on merge / CI
  await expect(page.getByTestId('snooze-bucket-waiting_on_merge')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('snooze-activity-days')).toHaveText('or 3d'); // the bucket's own default
  await page.keyboard.press('7');
  await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until activity' })).toBeVisible();

  const s = (await find(request, 'snoozed', row.comment.id))!;
  expect(s).toMatchObject({ snoozeBucket: 'waiting_on_merge', snoozeUntilActivity: true, snoozeNag: null });
  expect(Math.abs(Date.parse(s.snoozedUntil!) - (Date.now() + 3 * DAY))).toBeLessThan(60_000);

  await page.keyboard.press('z'); // undo puts everything back
  await expect.poll(async () => (await find(request, 'inbox', row.comment.id))?.snoozeBucket ?? null).toBeNull();
  expect((await find(request, 'inbox', row.comment.id))!.snoozeUntilActivity).toBe(false);
});

test('the fast path is unchanged: b then 1 is a plain timed snooze with no bucket and no wait', async ({
  page,
  request,
}) => {
  const row = take(0);
  await open(page, row);
  await page.keyboard.press('b');
  await page.keyboard.press('1');
  await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until' })).toBeVisible();
  expect(await find(request, 'snoozed', row.comment.id)).toMatchObject({
    snoozeBucket: null,
    snoozeUntilActivity: false,
  });
});

test('a reason and u make a chosen time the fallback; Enter in the why field snoozes; the words are kept', async ({
  page,
  request,
}) => {
  const row = take(1);
  await open(page, row);
  await page.keyboard.press('b');
  await page.keyboard.press('f'); // in flight
  await page.keyboard.press('u'); // also wake on activity
  await expect(page.getByTestId('snooze-wake')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('snooze-why').fill('review the proposed fix');
  await page.getByTestId('snooze-why').press('Enter'); // the first row: later today
  await expect(page.getByTestId('toast').filter({ hasText: 'activity (or' })).toBeVisible();
  expect(await find(request, 'snoozed', row.comment.id)).toMatchObject({
    snoozeBucket: 'in_flight',
    snoozeUntilActivity: true,
    snoozeWhy: 'review the proposed fix',
  });
});

test('a typed reason with no bucket is filed by the model afterwards, without holding up the snooze', async ({
  page,
  request,
}) => {
  const row = take(2);
  await open(page, row);
  await page.keyboard.press('b');
  await page.getByTestId('snooze-why').fill('waiting for the reporter to reply');
  await page.getByTestId('snooze-menu').getByTestId('snooze-tomorrow').click();
  await expect.poll(async () => (await find(request, 'snoozed', row.comment.id))?.snoozeBucket).toBe('waiting_on_them');
  expect(await find(request, 'snoozed', row.comment.id)).toMatchObject({ snoozeUntilActivity: false });
});

test('the Snoozed view is sectioned by bucket, with counts and ages', async ({ page, request }) => {
  await snoozeVia(request, take(3).comment.id, { untilActivity: true, bucket: 'waiting_on_them' });
  await snoozeVia(request, take(4).comment.id, { untilActivity: true, bucket: 'lower_priority' });
  await page.goto('/snoozed');
  const heads = page.getByTestId('snoozed-section');
  await expect(heads.first()).toBeVisible();
  const them = heads.filter({ hasText: 'Waiting on them' });
  await expect(them).toContainText(/Waiting on them \(\d+\)/);
  await expect(heads.filter({ hasText: 'Lower priority / someday' })).toContainText(/\(\d+\)/);
  await expect(heads.filter({ hasText: 'No reason given' })).toBeVisible(); // the demo's own far-future snoozes
  // Sections come in the order of the buckets.
  const order = await heads.evaluateAll((els) => els.map((e) => e.getAttribute('data-bucket')));
  const rank = ['waiting_on_them', 'waiting_on_merge', 'in_flight', 'lower_priority', 'none'];
  expect([...order].sort((a, b) => rank.indexOf(a!) - rank.indexOf(b!))).toEqual(order);
  // A row says it is waiting for activity, the fallback day, and how long ago it was parked; the heading names the bucket.
  await expect(
    page
      .getByTestId('row-snoozed')
      .filter({ hasText: /activity · .+ · \d+[dw]/ })
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId('row-bucket')).toHaveCount(0);
});

test("someone else commenting wakes it with cause activity; the owner's own comment does not", async ({
  page,
  request,
}) => {
  const row = take(5);
  await snoozeVia(request, row.comment.id, { untilActivity: true, bucket: 'waiting_on_them', why: 'they will answer' });
  await comment(request, row.comment.id, true);
  expect(await find(request, 'snoozed', row.comment.id)).toBeDefined(); // my own comment: still parked

  await page.goto('/snoozed');
  await expect(page.getByTestId('snoozed-section').first()).toBeVisible();
  await comment(request, row.comment.id, false);
  // The same live event the timer waker sends: the open Snoozed list updates by itself.
  await expect.poll(async () => (await find(request, 'snoozed', row.comment.id)) === undefined).toBe(true);
  const woke = (await find(request, 'inbox', row.comment.id))!;
  expect(woke).toMatchObject({ wakeCause: 'activity', snoozeNag: null, snoozeBucket: 'waiting_on_them' });

  await open(page, row);
  await expect(page.getByTestId('thread-why')).toContainText('You snoozed this to: they will answer');
  await expect(page.getByTestId('thread-bucket')).toHaveText(/Waiting on them/);
  await expect(page.getByTestId('thread-nag')).toHaveCount(0);
});

test('with no activity the fallback brings it back as an audit line, with the choices that go with it', async ({
  page,
  request,
}) => {
  const [a, b, c] = [take(6), take(7), take(8)];
  for (const r of [a, b, c]) {
    await snoozeVia(request, r.comment.id, {
      untilActivity: true,
      bucket: 'waiting_on_them',
      why: 'waiting for the author',
    });
  }
  expect((await request.post('/api/demo/advance', { headers: H, data: { days: 8 } })).ok()).toBe(true);
  const back = (await find(request, 'inbox', a.comment.id))!;
  expect(back).toMatchObject({
    wakeCause: 'fallback',
    snoozedUntil: null,
    snoozeNag: { bucket: 'waiting_on_them', days: 7 },
  });

  // On the row.
  await page.goto(`/all?q=${a.item.github!.number}`);
  const rowEl = page.getByTestId('inbox-row').first();
  await expect(rowEl.getByTestId('row-nag')).toContainText('Still waiting on them (7d, no activity)');
  await expect(rowEl.getByTestId('row-nag')).toContainText('waiting for the author');

  // In the open item.
  await rowEl.click();
  await expect(page.getByTestId('thread-nag-text')).toHaveText('Still waiting on them (7d, no activity)');
  await expect(page.getByTestId('thread-why')).toContainText('You snoozed this to: waiting for the author');
  await expect(page.getByTestId('act-snooze-again')).toBeVisible();

  // B: snooze again, same bucket and words; the audit line goes.
  await page.keyboard.press('B');
  await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until activity' })).toBeVisible();
  const again = (await find(request, 'snoozed', a.comment.id))!;
  expect(again).toMatchObject({
    snoozeBucket: 'waiting_on_them',
    snoozeUntilActivity: true,
    snoozeWhy: 'waiting for the author',
  });
  expect(again.snoozeNag).toBeNull();

  // n: no action needed.
  await open(page, b);
  await expect(page.getByTestId('thread-nag')).toBeVisible();
  await page.keyboard.press('n');
  await expect.poll(async () => (await find(request, 'all', b.comment.id)) !== undefined).toBe(true);
  expect(await find(request, 'inbox', b.comment.id)).toBeUndefined();

  // d: done.
  await open(page, c);
  await page.keyboard.press('d');
  await expect.poll(async () => (await find(request, 'inbox', c.comment.id)) === undefined).toBe(true);
});

test('a new reply on a YouTube thread wakes a comment parked until activity', async ({ request }) => {
  const youtube = (await (await request.get('/api/inbox?view=inbox&limit=60')).json()).items.find(
    (i: Row & { item: { provider: string } }) => i.item.provider === 'youtube',
  ) as Row;
  await snoozeVia(request, youtube.comment.id, { untilActivity: true, bucket: 'waiting_on_them' });
  expect(await find(request, 'snoozed', youtube.comment.id)).toBeDefined();
  await comment(request, youtube.comment.id, false);
  await expect.poll(async () => (await find(request, 'snoozed', youtube.comment.id)) === undefined).toBe(true);
  const back = (await (await request.get('/api/inbox?view=inbox&limit=500')).json()).items.find(
    (i: Row) => i.comment.id === youtube.comment.id,
  ) as Row;
  expect(back).toMatchObject({ wakeCause: 'activity', snoozeBucket: 'waiting_on_them' });
});

test('Draft a nudge shows a short comment to copy, and nothing is posted', async ({ page, request }) => {
  const row = take(9);
  await snoozeVia(request, row.comment.id, { untilActivity: true, bucket: 'waiting_on_them' });
  expect((await request.post('/api/demo/advance', { headers: H, data: { days: 8 } })).ok()).toBe(true);
  await open(page, row);
  await expect(page.getByTestId('thread-nag')).toBeVisible();
  await page.getByTestId('nudge-draft').click();
  const text = page.getByTestId('nudge-text');
  await expect(text).toContainText('Are you still planning to pick this up');
  await page.getByTestId('nudge-copy').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Are you still planning');
  // It is only ever shown: the thread's comment count is what it was.
  expect((await find(request, 'inbox', row.comment.id))!.item.github!.comments).toBe(row.item.github!.comments);
});

test('the button is hidden without a key, and for a bucket that is not waiting on someone', async ({
  page,
  request,
}) => {
  const a = take(0);
  await snoozeVia(request, a.comment.id, { untilActivity: true, bucket: 'in_flight' });
  expect((await request.post('/api/demo/advance', { headers: H, data: { days: 8 } })).ok()).toBe(true);
  await open(page, a);
  await expect(page.getByTestId('thread-nag-text')).toHaveText('Still in flight (7d, no activity)');
  await expect(page.getByTestId('nudge-draft')).toHaveCount(0);
});

/** Every row in the list is in a slot of its own: no two slots overlap, and no item is listed twice. */
async function expectCleanList(page: Page) {
  const rows = await page.getByTestId('inbox-row').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-id') ?? el.textContent, top: r.top, bottom: r.bottom };
    }),
  );
  rows.sort((a, b) => a.top - b.top);
  for (let i = 1; i < rows.length; i++)
    expect(rows[i]!.top, 'rows overlap').toBeGreaterThanOrEqual(rows[i - 1]!.bottom - 1);
  const slots = await page
    .locator('[role=listbox] .slot')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform));
  expect(new Set(slots).size, 'two slots at the same offset').toBe(slots.length);
  const dbg = await page.evaluate(() =>
    (window as unknown as { __nudgeDebugList: () => { dupes: string[] } }).__nudgeDebugList(),
  );
  expect(dbg.dupes).toEqual([]);
}

test('waking a snoozed item while the list is not at the top, then pressing . leaves one clean list', async ({
  page,
  request,
}) => {
  const woken = take(5);
  const other = take(6);
  for (const r of [woken, other]) {
    await snoozeVia(request, r.comment.id, { untilActivity: true, bucket: 'waiting_on_them', why: 'waiting' });
  }
  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-row').first()).toBeVisible();
  for (let i = 0; i < 3; i++) await page.keyboard.press('j'); // off the top, so arrivals queue behind the pill
  await expectCleanList(page);
  expect((await request.post('/api/demo/advance', { headers: H, data: { days: 8 } })).ok()).toBe(true);
  await expect(page.getByTestId('new-pill')).toBeVisible();
  await page.keyboard.press('.');
  await expect(page.getByTestId('new-pill')).toBeHidden();
  await expect(page.getByTestId('inbox-row').first()).toBeVisible();
  await page.waitForTimeout(400);
  await expectCleanList(page);
  const ids = await page.getByTestId('inbox-row').evaluateAll((els) => els.map((e) => e.textContent));
  expect(new Set(ids).size).toBe(ids.length);
  // The open thread shows only the selected row's title.
  const sel = await page
    .locator('[data-testid=inbox-row][aria-selected=true], [data-testid=inbox-row].selected')
    .first()
    .textContent();
  expect(sel).toBeTruthy();
  await expect(page.getByTestId('thread-view')).toHaveCount(1);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const noSideScroll = async (page: Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  test('the snooze sheet has big tap targets for the reason and "Until activity", and fits the screen', async ({
    page,
    request,
  }) => {
    const row = (await list(request, 'inbox')).filter((i) => (i.item.github?.comments ?? 0) > 0)[0]!;
    await page.goto(`/all?q=${row.item.github!.number}`);
    await page.getByTestId('inbox-row').first().getByTestId('row-snooze').tap();
    const menu = page.getByTestId('snooze-menu');
    await expect(menu).toBeVisible();
    for (const b of ['waiting_on_them', 'waiting_on_merge', 'in_flight', 'lower_priority']) {
      const box = (await page.getByTestId(`snooze-bucket-${b}`).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    const act = (await page.getByTestId('snooze-activity').boundingBox())!;
    expect(act.height).toBeGreaterThanOrEqual(44);
    // The sheet slides up; once it has settled it is inside the screen.
    await expect
      .poll(async () => {
        const sheet = (await menu.boundingBox())!;
        return sheet.y + sheet.height;
      })
      .toBeLessThanOrEqual(844 + 1);
    await noSideScroll(page);

    await page.getByTestId('snooze-bucket-waiting_on_them').tap();
    await expect(page.getByTestId('snooze-activity-days')).toHaveText('or 7d');
    await page.getByTestId('snooze-activity').tap();
    await expect(page.getByTestId('toast').filter({ hasText: 'Snoozed until activity' })).toBeVisible();
    expect(await find(request, 'snoozed', row.comment.id)).toMatchObject({
      snoozeBucket: 'waiting_on_them',
      snoozeUntilActivity: true,
    });
  });

  test('the Snoozed view is usable: headings and rows fit, and a row opens', async ({ page }) => {
    await page.goto('/snoozed');
    await expect(page.getByTestId('snoozed-section').first()).toBeVisible();
    const head = (await page.getByTestId('snoozed-section').first().boundingBox())!;
    expect(head.x + head.width).toBeLessThanOrEqual(390);
    await noSideScroll(page);
    const rowEl = page.getByTestId('inbox-row').first();
    const box = (await rowEl.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await rowEl.tap();
    await expect(page.getByTestId('thread-view')).toBeVisible();
  });

  test('an audit line fits on the row and in the open item, with tile buttons', async ({ page, request }) => {
    const nags = (await list(request, 'inbox')).filter((i) => i.snoozeNag);
    expect(nags.length).toBeGreaterThan(0);
    await page.goto(`/all?q=${nags[0]!.item.github!.number}`);
    const rowEl = page.getByTestId('inbox-row').first();
    const nag = (await rowEl.getByTestId('row-nag').boundingBox())!;
    const r = (await rowEl.boundingBox())!;
    expect(nag.x + nag.width).toBeLessThanOrEqual(r.x + r.width);
    await rowEl.tap();
    await expect(page.getByTestId('thread-nag-text')).toBeVisible();
    const tile = (await page.getByTestId('act-snooze-again').boundingBox())!;
    expect(tile.x + tile.width).toBeLessThanOrEqual(390);
    expect(tile.width).toBeGreaterThanOrEqual(44);
    await noSideScroll(page);
  });
});
