import { test, expect, raise, card, dragCard } from '../fixtures';

/**
 * The board itself: the parts that only exist in a browser, and that no server
 * test can reach — layout, pointer behaviour, and what a card looks like.
 */

test('the board is readable without signing in', async ({ page, api }) => {
  await raise(api, { title: 'Visible to everybody' });

  await page.goto('/');
  await expect(page.locator('.column')).not.toHaveCount(0);
  await expect(page.getByText('Visible to everybody')).toBeVisible();
  // and there is no way in for someone not signed in
  await expect(page.locator('.split-main')).toHaveCount(0);
});

test('a signed-in person can raise a bug through the form', async ({ adminPage: page }) => {
  await page.goto('/');
  await page.locator('.split-main').click();

  await page.locator('#nb-title').fill('Raised through the form');
  await page.locator('#nb-desc').fill('Typed by a person.');
  await page.getByRole('button', { name: /^Raise bug$/ }).click();

  // The ticket opens on creation, so the dialog is the new one.
  await expect(page.locator('.modal.wide h2')).toHaveText('Raised through the form');
  await page.locator('.close').click();
  await expect(page.getByText('Raised through the form')).toBeVisible();
});

test('a feature request asks different questions from a bug', async ({ adminPage: page }) => {
  await page.goto('/');
  await page.locator('.split-toggle').click();
  await page.getByRole('menuitem', { name: /feature request/i }).click();

  await expect(page.locator('#nb-steps')).toHaveCount(0);
  await expect(page.locator('#nb-ver')).toHaveCount(0);
  await expect(page.locator('#nb-stack')).toHaveCount(0);
  await expect(page.locator('label[for="nb-sev"]')).toHaveText(/how much do you want it/i);
});

test('severity colours the strip down the card', async ({ page, api }) => {
  const critical = await raise(api, { title: 'Critical one', severity: 'critical' });
  const trivial = await raise(api, { title: 'Trivial one', severity: 'trivial' });

  await page.goto('/');

  const stripe = (id: number) =>
    card(page, id).evaluate((el) => getComputedStyle(el).borderLeftColor);

  expect(await stripe(critical)).toBe('rgb(255, 90, 90)');
  expect(await stripe(trivial)).toBe('rgb(78, 78, 94)');
  expect(await stripe(critical)).not.toBe(await stripe(trivial));
});

test('a card carries its type as an emoji, bottom right', async ({ page, api }) => {
  const bug = await raise(api, { title: 'A bug' });
  const feature = await raise(api, { title: 'A request', kind: 'feature', severity: 'want' });

  await page.goto('/');

  await expect(card(page, bug).locator('.kind-emoji')).toHaveText('🐞');
  await expect(card(page, feature).locator('.kind-emoji')).toHaveText('💡');

  // last in the footer row, which is what puts it in the corner
  const isLast = await card(page, bug).evaluate((el) =>
    el.querySelector('.card-meta')?.lastElementChild?.classList.contains('kind-emoji'),
  );
  expect(isLast).toBe(true);
});

test('a manager drags a card to another lane, and it stays there', async ({ adminPage: page, api }) => {
  const id = await raise(api, { title: 'Drag me somewhere' });

  await page.goto('/');
  await expect(card(page, id)).toBeVisible();

  await dragCard(page, id, { lane: 'Backlog' });

  // Believe the server, not the pixels: reload and check it is still there.
  await page.reload();
  const lane = page.locator('.column').filter({
    has: page.locator('.column-head h2', { hasText: 'Backlog' }),
  });
  await expect(lane.locator(`[data-card="${id}"]`)).toBeVisible();
});

test('somebody without manage cannot drag at all', async ({ plainPage: page, api }) => {
  const id = await raise(api, { title: 'Not yours to move' });

  await page.goto('/');
  await dragCard(page, id, { lane: 'Backlog' });

  await page.reload();
  const intake = page.locator('.column').filter({
    has: page.locator('.column-head h2', { hasText: 'Unconfirmed' }),
  });
  await expect(intake.locator(`[data-card="${id}"]`)).toBeVisible();
});

test('dropping on the middle of a card merges; the edge does not', async ({
  adminPage: page,
  api,
}) => {
  const keep = await raise(api, { title: 'The one that survives' });
  const dupe = await raise(api, { title: 'The duplicate' });
  const other = await raise(api, { title: 'Merely reordered' });

  await page.goto('/');

  // The edge of a card belongs to the lane, so a full lane always has
  // somewhere to drop *between* two cards.
  const edgeMerges = await dragCard(page, other, { card: keep }, 'top');
  expect(edgeMerges, 'the edge of a card is not a merge target').toBe(false);
  await page.reload();
  await expect(card(page, other), 'it moved rather than merging').toBeVisible();

  // The middle of a card is the merge target.
  const middleMerges = await dragCard(page, dupe, { card: keep }, 'middle');
  expect(middleMerges, 'the middle of a card is a merge target').toBe(true);
  await page.reload();

  await expect(card(page, dupe), 'the duplicate leaves the board').toHaveCount(0);
  await expect(card(page, keep).locator('.pill.dup')).toHaveText('×2');
});
