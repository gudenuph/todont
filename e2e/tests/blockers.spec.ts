import { test, expect, raise, card } from '../fixtures';

/**
 * Dependencies, and the hover behaviour that explains them.
 *
 * The dimming is the reason this file exists: it is computed from live layout
 * and opacity, so nothing short of a browser can tell whether it works.
 */

async function block(api: Parameters<typeof raise>[0], blocked: number, blocker: number) {
  const res = await api.post(`/api/bugs/${blocked}/blockers`, { data: { blockerId: blocker } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test('a blocked card says so, and its strip goes dashed', async ({ page, api }) => {
  const waiting = await raise(api, { title: 'Waiting on something' });
  const holdingUp = await raise(api, { title: 'The thing it waits on' });
  await block(api, waiting, holdingUp);

  await page.goto('/');

  await expect(card(page, waiting).locator('.pill.blocked')).toHaveText('blocked');
  await expect(card(page, holdingUp).locator('.pill.blocked')).toHaveCount(0);

  const style = await card(page, waiting).evaluate((el) => getComputedStyle(el).borderLeftStyle);
  expect(style).toBe('dashed');
});

test('hovering a blocked card dims everything that is not holding it up', async ({ page, api }) => {
  const waiting = await raise(api, { title: 'Blocked ticket' });
  const holdingUp = await raise(api, { title: 'Its blocker' });
  const unrelated = await raise(api, { title: 'Nothing to do with it' });
  const alsoUnrelated = await raise(api, { title: 'Also unrelated' });
  await block(api, waiting, holdingUp);

  await page.goto('/');
  const opacity = (id: number) => card(page, id).evaluate((el) => getComputedStyle(el).opacity);

  // At rest, nothing is dimmed.
  expect(await opacity(unrelated)).toBe('1');

  await card(page, waiting).hover();
  await page.waitForTimeout(250);

  expect(await opacity(waiting), 'the hovered card stays lit').toBe('1');
  expect(await opacity(holdingUp), 'so does what is holding it up').toBe('1');
  expect(await opacity(unrelated), 'everything else steps back').toBe('0.5');
  expect(await opacity(alsoUnrelated)).toBe('0.5');

  // Moving away puts it all back.
  await page.mouse.move(5, 700);
  await page.waitForTimeout(250);
  expect(await opacity(unrelated)).toBe('1');
});

test('hovering a card that is not blocked dims nothing', async ({ page, api }) => {
  const waiting = await raise(api, { title: 'Blocked' });
  const holdingUp = await raise(api, { title: 'Blocker' });
  const unrelated = await raise(api, { title: 'Unrelated' });
  await block(api, waiting, holdingUp);

  await page.goto('/');
  await card(page, holdingUp).hover();
  await page.waitForTimeout(250);

  // There would be nothing to point at, so pointing is not offered.
  await expect(page.locator('.card.dimmed')).toHaveCount(0);
  expect(await card(page, unrelated).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test('a manager adds and removes a blocker from the ticket', async ({ adminPage: page, api }) => {
  const waiting = await raise(api, { title: 'Needs the other one first' });
  const holdingUp = await raise(api, { title: 'Has to happen first' });

  await page.goto(`/#/bug/${waiting}`);
  await expect(page.locator('.modal.wide')).toBeVisible();

  await page.locator('select[aria-label="Add a blocker"]').selectOption(String(holdingUp));
  await page.getByRole('button', { name: 'Add' }).click();

  const blockedBy = page.locator('.dep-group').first();
  await expect(blockedBy.locator('.dep-chip')).toContainText(`#${holdingUp}`);

  // The other end of the same edge shows on the other ticket.
  await page.goto(`/#/bug/${holdingUp}`);
  await expect(page.locator('.dep-group').last().locator('.dep-chip')).toContainText(`#${waiting}`);

  // Removing from either end drops it.
  await page.locator('.dep-group').last().locator('.dep-remove').click();
  await expect(page.locator('.dep-group').last().locator('.dep-chip')).toHaveCount(0);
});

test('somebody without manage sees dependencies but cannot change them', async ({
  plainPage: page,
  api,
}) => {
  const waiting = await raise(api, { title: 'Read-only dependency' });
  const holdingUp = await raise(api, { title: 'The blocker' });
  await block(api, waiting, holdingUp);

  await page.goto(`/#/bug/${waiting}`);

  await expect(page.locator('.dep-chip')).toContainText(`#${holdingUp}`);
  await expect(page.locator('.dep-remove')).toHaveCount(0);
  await expect(page.locator('select[aria-label="Add a blocker"]')).toHaveCount(0);
});
