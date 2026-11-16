import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Adventure mode (docs/RPG.md) on a private demo server: the chip, the Hall of Heroes, the level-up toast (and its
// chime, through a stand-in AudioContext: nothing can be heard in CI), a missed campfire day (the demo can run the
// mode's own clock ahead), the phone layout and the off switch. The tests build on each other's XP, so they run in
// order, and days are counted in UTC so the campfire arithmetic below is exact.
test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: 'UTC' });

const H = { 'x-nudge': '1' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHOTS = process.env.NUDGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

/** Records what the level-up chime asks of the audio API, in place of the real one. */
const stubAudio = () => {
  const w = window as unknown as Record<string, unknown>;
  const log = { made: 0, oscillators: 0 };
  w.__audio = log;
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    constructor() {
      log.made++;
    }
    resume() {
      return Promise.resolve();
    }
    createGain() {
      return { gain: param(), connect() {} };
    }
    createOscillator() {
      log.oscillators++;
      return { type: 'sine', frequency: param(), connect() {}, start() {}, stop() {} };
    }
  }
  w.AudioContext = FakeAudioContext;
  w.webkitAudioContext = FakeAudioContext;
};
const audio = (page: Page) =>
  page.evaluate(() => (window as unknown as { __audio: { made: number; oscillators: number } }).__audio);

/** Mark `n` YouTube inbox items done, one action each (8 XP apiece: they arrived just now, so no patience bonus). */
async function doneOneByOne(request: APIRequestContext, n: number) {
  const res = await request.get('/api/inbox?view=inbox&limit=500');
  const ids = ((await res.json()) as { items: { item: { provider: string }; comment: { id: string } }[] }).items
    .filter((i) => i.item.provider === 'youtube')
    .map((i) => i.comment.id)
    .slice(0, n);
  expect(ids).toHaveLength(n);
  for (const id of ids) {
    expect((await request.post('/api/triage', { headers: H, data: { commentIds: [id], to: 'done' } })).ok()).toBe(true);
  }
}
const sheet = async (request: APIRequestContext) =>
  (await (await request.get('/api/rpg?tz=UTC')).json()) as { xp: number; level: number };

async function openInbox(page: Page) {
  await page.goto('/inbox');
  await page.waitForSelector('[data-testid=inbox-row]');
}

test('the chip shows the level and title, and the first visit says where you arrive', async ({ page }) => {
  await openInbox(page);
  const chip = page.getByTestId('rpg-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Lv 1');
  await expect(page.getByTestId('rpg-chip-title')).toHaveText('Inbox Peasant');
  await expect(page.getByTestId('toast').filter({ hasText: 'You arrive as a Level 1 Inbox Peasant.' })).toBeVisible();
  await expect(chip).toHaveAttribute('title', /0 XP · 300 to level 2/);
  await shot(page, 'rpg-chip-desktop');
  // Nothing about XP anywhere in the list.
  await expect(page.getByTestId('inbox-row').first()).not.toContainText('XP');
});

test('the Hall of Heroes sits at the bottom of Stats, and the palette goes there', async ({ page }) => {
  await openInbox(page);
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette').locator('input').fill('Character sheet');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/stats$/);
  const hall = page.getByTestId('hall');
  await expect(hall).toBeVisible();
  await expect(page.getByTestId('hall-title')).toHaveText('Lv 1 · Inbox Peasant');
  await expect(hall.getByTestId('hall-boss')).toHaveCount(4);
  await expect(hall.getByTestId('hall-achievement')).toHaveCount(40);
  // Hidden ones are "???" until earned; unearned ones are greyed silhouettes, a ladder's showing tier I.
  await expect(hall.getByTestId('hall-achievement').filter({ hasText: '???' })).toHaveCount(12);
  await expect(hall.locator('svg.sil').first()).toBeVisible();
  const duck = hall.locator('[data-testid=hall-achievement][data-id=rubber_duck]');
  await expect(duck).toHaveAttribute('data-tier', '0');
  await expect(duck).toContainText('Completed 10 todos.');
  await expect(duck.getByTestId('hall-achievement-progress')).toHaveText('0 of 10');
  await expect(duck.locator('svg.sil [data-numeral]')).toHaveAttribute('data-numeral', 'I');
  await expect(hall.getByTestId('hall-achievement-count')).toHaveText(/^0 of 40 · 0 of \d{3} tiers$/);
  await expect(hall.getByTestId('hall-loot')).toHaveCount(10);
  // The chip is a link to the same place.
  await openInbox(page);
  await page.getByTestId('rpg-chip').click();
  await expect(page).toHaveURL(/\/stats$/);
  await expect(page.getByTestId('hall')).toBeInViewport();
});

test('enough triage brings one level-up toast, which takes no focus and dings once', async ({ page, request }) => {
  await page.addInitScript(stubAudio);
  await openInbox(page);
  await expect(page.getByTestId('rpg-chip')).toBeVisible();
  // The chime needs a gesture before it may play: an ordinary click somewhere harmless.
  await page.getByText('Nudge', { exact: true }).click();
  await page.locator('body').focus();
  const focusedBefore = await page.evaluate(() => document.activeElement?.tagName);
  await doneOneByOne(request, 38); // 304 XP: level 2 needs 300
  expect(await sheet(request)).toMatchObject({ level: 2 });

  const ding = page.getByTestId('toast').filter({ hasText: /^Ding! Level 2: Apprentice of the Unread\./ });
  await expect(ding).toBeVisible();
  await expect(page.getByTestId('rpg-chip-title')).toHaveText('Apprentice of the Unread');
  await expect(page.getByTestId('rpg-hat')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(focusedBefore);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid=toast]'))).toBe(false);
  expect(await audio(page)).toMatchObject({ made: 1 });
  expect((await audio(page)).oscillators).toBeGreaterThan(0);
  await shot(page, 'rpg-levelup-desktop');
  // It closes by itself.
  await expect(ding).toHaveCount(0, { timeout: 15_000 });
});

test('with the sound switched off, a level-up makes no audio call at all', async ({ page, request }) => {
  await page.addInitScript(stubAudio);
  await page.goto('/settings');
  const sound = page.getByTestId('rpg-sound');
  await expect(sound).toBeChecked();
  await sound.uncheck();
  await expect(sound).not.toBeChecked();
  await openInbox(page);
  await page.getByText('Nudge', { exact: true }).click();
  await page.keyboard.press('Shift');
  const before = await sheet(request);
  await doneOneByOne(request, Math.ceil((910 - before.xp) / 8)); // level 3 needs 910
  await expect(page.getByTestId('toast').filter({ hasText: /^Ding! Level 3/ })).toBeVisible();
  expect(await audio(page)).toEqual({ made: 0, oscillators: 0 });
  // Back on for the rest.
  expect((await request.put('/api/settings', { headers: H, data: { rpg: { sound: true } } })).ok()).toBe(true);
});

test('a ladder shows its tier, the numeral on the badge and progress to the next tier', async ({ page }) => {
  await page.goto('/stats');
  const hall = page.getByTestId('hall');
  // Over a hundred done by now: Veteran of the Queue I, on the way to II at 500.
  const vet = hall.locator('[data-testid=hall-achievement][data-id=veteran]');
  await expect(vet).toHaveAttribute('data-tier', '1');
  await expect(vet.locator('strong')).toHaveText('Veteran of the Queue I');
  await expect(vet).toContainText('Next: Dealt with 500 items, done or replied.');
  await expect(vet.getByTestId('hall-achievement-progress')).toHaveText(/^1\d\d of 500$/);
  await expect(vet.getByTestId('hall-achievement-tier')).toHaveText(/^I of VI · earned /);
  await expect(vet.locator('svg:not(.sil) [data-numeral]')).toHaveAttribute('data-numeral', 'I');
  await expect(vet.locator('svg circle[data-ring]')).toHaveAttribute('data-ring', 'bronze');
  // A one-off has no numeral.
  const first = hall.locator('[data-testid=hall-achievement][data-id=first_blood]');
  await expect(first).toHaveAttribute('data-earned', 'true');
  await expect(first.locator('[data-numeral]')).toHaveCount(0);
  await expect(hall.getByTestId('hall-achievement-count')).not.toHaveText(/^0 of/);
  if (SHOTS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await hall.locator('h3', { hasText: 'Achievements' }).scrollIntoViewIfNeeded();
      await shot(page, `rpg-hall-desktop-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: null });
  }
});

test.describe('a missed campfire day', () => {
  /** Campfire day (UTC, 04:00 rollover) as a day number, and the moment the mode's clock should show. */
  const campDay = (t: number) => Math.floor((t - 4 * HOUR) / DAY);
  const weekday = (day: number) =>
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(day * DAY).getUTCDay()];
  const runAhead = async (request: APIRequestContext, target: number) => {
    const hours = Math.ceil((target - Date.now()) / HOUR);
    expect((await request.post('/api/demo/rpg-clock', { headers: H, data: { hours } })).ok()).toBe(true);
  };
  test.afterAll(async ({ request }) => {
    await request.post('/api/demo/rpg-clock', { headers: H, data: { hours: 0 } });
  });

  test('is covered by the rest day, then a second one puts the fire out; each is said once', async ({
    page,
    request,
  }) => {
    // Today had work done (the tests above). Run the clock to 16:00 two days on: tomorrow, with items waiting and
    // nothing done, is then over by more than six hours.
    const today = campDay(Date.now());
    await runAhead(request, (today + 2) * DAY + 16 * HOUR);
    await openInbox(page);
    const forgiven = `You missed ${weekday(today + 1)}. The campfire flickers. A rest day covered it.`;
    await expect(page.getByTestId('toast').filter({ hasText: forgiven })).toBeVisible();
    await expect(page.getByTestId('rpg-chip')).toHaveAttribute('title', new RegExp(forgiven.replace(/\./g, '\\.')));
    const again = await request.post('/api/rpg/claim', { headers: H, data: { tz: 'UTC' } });
    expect((await again.json()).news.campfire).toBeNull();
    await page.goto('/stats');
    await expect(page.getByTestId('hall-campfire-notice')).toHaveText(forgiven);
    await expect(page.getByTestId('hall-campfire').filter({ hasText: 'Rest day used' })).toBeVisible();

    await runAhead(request, (today + 3) * DAY + 16 * HOUR);
    await openInbox(page);
    const out = `The campfire went out on ${weekday(today + 2)}. Light it again with any reply.`;
    await expect(page.getByTestId('toast').filter({ hasText: out })).toBeVisible();
    // Nothing else is touched: the level stays.
    expect(await sheet(request)).toMatchObject({ level: 3 });
    await page.goto('/stats');
    await expect(page.getByTestId('hall-campfire-notice')).toHaveText(out);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the chip sits behind More, and the Hall fits the screen', async ({ page }) => {
    await openInbox(page);
    const chip = page.getByTestId('rpg-chip');
    await expect(chip).toBeHidden();
    await page.getByTestId('nav-more').click();
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Lv 3');
    // A query change (moving the selection rewrites ?c=) must not close the popover; only a change of view does.
    const url = page.url();
    await page.keyboard.press('j');
    await expect(page).not.toHaveURL(url);
    await expect(chip).toBeVisible();
    await shot(page, 'rpg-chip-phone');
    await chip.click();
    await expect(page).toHaveURL(/\/stats$/);
    await expect(page.getByTestId('hall')).toBeInViewport();
    await shot(page, 'rpg-hall-phone');
    if (SHOTS) {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.getByTestId('hall').locator('h3', { hasText: 'Achievements' }).scrollIntoViewIfNeeded();
        await shot(page, `rpg-hall-phone-${scheme}`);
      }
      await page.emulateMedia({ colorScheme: null });
    }
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const hall = document.querySelector('[data-testid=hall]')!;
      const scroller = hall.parentElement!;
      return { doc, page: scroller.scrollWidth - scroller.clientWidth, hall: hall.scrollWidth - hall.clientWidth };
    });
    expect(overflow).toEqual({ doc: 0, page: 0, hall: 0 });
  });
});

test('switched off, the chip, Hall, palette entry and every /api/rpg call are gone', async ({ page }) => {
  await page.goto('/settings');
  await page.getByTestId('rpg-enabled').uncheck();
  await expect(page.getByTestId('rpg-sound')).toBeDisabled();
  await expect(page.getByTestId('rpg-chip')).toHaveCount(0);

  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/rpg')) calls.push(r.url());
  });
  await openInbox(page);
  await page.keyboard.press('e'); // a triage: the inbox counts change, which would normally ask again
  await expect(page.getByTestId('toast').filter({ hasText: 'done' }).first()).toBeVisible();
  await page.waitForTimeout(2500); // longer than the mode's debounce
  await expect(page.getByTestId('rpg-chip')).toHaveCount(0);
  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: 'Stats' })).toBeVisible();
  await expect(page.getByTestId('hall')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette').locator('input').fill('Character sheet');
  await expect(page.getByTestId('palette')).not.toContainText('Character sheet');
  await page.keyboard.press('Escape');
  expect(calls).toEqual([]);

  // On again: a fresh arrival, at the level earned all along.
  await page.goto('/settings');
  await page.getByTestId('rpg-enabled').check();
  await expect(page.getByTestId('toast').filter({ hasText: 'You arrive as a Level 3' })).toBeVisible();
});
