import { test, expect, raise, card, lane } from '../fixtures';

/**
 * The board keeping itself current.
 *
 * The interval is set to its floor for these, so a change lands within a few
 * seconds rather than the default twenty. That is done through the admin API
 * and put back afterwards, because every test here shares one board.
 */

const FAST = 5_000;

test.beforeEach(async ({ api }) => {
  await api.patch('/api/admin/instance', {
    data: { 'live.enabled': true, 'live.intervalSeconds': 5, 'live.animate': true },
  });
});

test('a ticket raised elsewhere appears without a reload', async ({ page, api }) => {
  await page.goto('/');
  await expect(page.locator('.column')).not.toHaveCount(0);

  // Somebody else, somewhere else.
  const id = await raise(api, { title: 'Raised while you were looking' });

  await expect(card(page, id)).toBeVisible({ timeout: FAST * 3 });
  await expect(page.getByText('Raised while you were looking')).toBeVisible();
});

test('a new arrival is marked as new, and the mark fades', async ({ page, api }) => {
  // A card that is already there before the page opens, so waiting for it
  // proves the board has finished loading. Raising the one under test before
  // that would simply make it part of what was there on arrival.
  const seed = await raise(api, { title: 'Already on the board' });

  await page.goto('/');
  await expect(card(page, seed)).toBeVisible();

  const id = await raise(api, { title: 'Should be badged' });

  await expect(card(page, id)).toHaveClass(/just-new/, { timeout: FAST * 3 });

  // It is an announcement, not a state: it clears itself.
  await expect(card(page, id)).not.toHaveClass(/just-new/, { timeout: 15_000 });
  await expect(card(page, id)).toBeVisible();
});

test('a card moved by somebody else arrives in its new lane, marked', async ({ page, api }) => {
  const id = await raise(api, { title: 'Moved from another window' });

  await page.goto('/');
  await expect(card(page, id)).toBeVisible();

  const moved = await api.post(`/api/bugs/${id}/move`, { data: { status: 'backlog' } });
  expect(moved.ok(), await moved.text()).toBeTruthy();

  await expect(card(page, id)).toHaveClass(/just-moved/, { timeout: FAST * 3 });
  await expect(lane(page, 'Backlog').locator(`[data-card="${id}"]`)).toBeVisible();
});

test('an edit elsewhere marks the card as updated', async ({ page, api }) => {
  const id = await raise(api, { title: 'About to be edited' });

  await page.goto('/');
  await expect(card(page, id)).toBeVisible();

  const edited = await api.patch(`/api/bugs/${id}`, { data: { title: 'Edited from elsewhere' } });
  expect(edited.ok(), await edited.text()).toBeTruthy();

  await expect(card(page, id)).toHaveClass(/just-updated/, { timeout: FAST * 3 });
  await expect(page.getByText('Edited from elsewhere')).toBeVisible();
});

test('switching it off in the panel stops an already-open board polling', async ({
  page,
  api,
}) => {
  await page.goto('/');
  await expect(page.locator('.column')).not.toHaveCount(0);

  await api.patch('/api/admin/instance', { data: { 'live.enabled': false } });

  // Give the tab time to notice, then change something it must not pick up.
  await expect
    .poll(async () => (await (await api.get('/api/board/version')).json()).live.enabled)
    .toBe(false);

  const id = await raise(api, { title: 'Should stay hidden until reload' });

  // Long enough that a live board would certainly have shown it.
  await page.waitForTimeout(FAST * 3);
  await expect(card(page, id)).toHaveCount(0);

  // and it is there on a reload, so nothing was lost — only not pushed.
  await page.reload();
  await expect(card(page, id)).toBeVisible();
});

test('a board being dragged is not re-rendered underneath the pointer', async ({
  adminPage: page,
  api,
}) => {
  const dragged = await raise(api, { title: 'Held under the mouse' });

  await page.goto('/');
  const handle = card(page, dragged);
  await expect(handle).toBeVisible();

  // A full lane scrolls, and the pointer cannot reach a card below the fold.
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Past the 5px activation distance, in steps, or the sensor never fires.
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 12, { steps: 8 });
  await expect(page.locator('.card.dragging')).toHaveCount(1);

  // Something changes while the pointer is still down.
  await raise(api, { title: 'Arrived mid-drag' });
  await page.waitForTimeout(FAST * 2);

  // The card is still the one being dragged, and the board has not jumped.
  await expect(page.locator('.card.dragging')).toHaveCount(1);
  await expect(page.getByText('Arrived mid-drag')).toHaveCount(0);

  await page.mouse.up();

  // Once the drag is over, the poll catches up on its own.
  await expect(page.getByText('Arrived mid-drag')).toBeVisible({ timeout: FAST * 3 });
});
