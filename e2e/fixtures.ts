import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Two people, signed in once by the global setup: the first account, which is
 * admin, and an ordinary one. Their sessions are reused rather than remade, so
 * the login rate limit stays on and still never fires.
 */
const stateDir = () => path.join(__dirname, '.data', process.env.E2E_RUN_ID ?? 'state');
const adminState = () => path.join(stateDir(), 'admin.json');
const plainState = () => path.join(stateDir(), 'plain.json');

export const test = base.extend<{
  /** A page already signed in as the admin, who is also a manager. */
  adminPage: Page;
  /** A page signed in as somebody with no special powers. */
  plainPage: Page;
  /** Authenticated API access, for arranging a board without clicking. */
  api: APIRequestContext;
}>({
  adminPage: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL, storageState: adminState() });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  plainPage: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL, storageState: plainState() });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  api: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({ baseURL, storageState: adminState() });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };

/** Raise a ticket without going through the form. Returns its id. */
export async function raise(
  api: APIRequestContext,
  fields: Record<string, unknown>,
): Promise<number> {
  const res = await api.post('/api/bugs', { data: fields });
  expect(res.ok(), `raise failed: ${await res.text()}`).toBeTruthy();
  return (await res.json()).bug.id as number;
}

/** The card for a ticket, by its number. */
export const card = (page: Page, id: number) => page.locator(`[data-card="${id}"]`);

/** A lane, by the heading people read. */
export const lane = (page: Page, name: string) =>
  page.locator('.column').filter({ has: page.locator('.column-head h2', { hasText: name }) });

/**
 * Drag one card onto another, or onto a lane.
 *
 * dnd-kit needs the pointer to travel past its activation distance in more than
 * one step, and the app decides between "move here" and "merge with this" from
 * where in the target the pointer lands — so both are parameters rather than
 * assumptions buried in a helper.
 *
 * Returns whether the app was going to merge at the moment of release, so a
 * test can assert on the decision as well as on what came of it.
 */
export async function dragCard(
  page: Page,
  fromId: number,
  target: { card?: number; lane?: string },
  where: 'middle' | 'top' = 'middle',
): Promise<boolean> {
  const source = card(page, fromId);
  const dest = target.card !== undefined ? card(page, target.card) : lane(page, target.lane!);

  // A full lane scrolls, and the pointer cannot reach a card below the fold.
  await source.scrollIntoViewIfNeeded();
  await dest.scrollIntoViewIfNeeded();

  const from = await source.boundingBox();
  const to = await dest.boundingBox();
  if (!from || !to) throw new Error('could not measure the drag');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 24, from.y + from.height / 2 + 12, { steps: 6 });

  // Measure again mid-drag: the drop indicator changes the column's height as
  // it appears, so where the target sits now is not where it sat at rest.
  const live = (await dest.boundingBox()) ?? to;
  const y = where === 'middle' ? live.y + live.height / 2 : live.y + 3;

  await page.mouse.move(live.x + live.width / 2, y, { steps: 12 });
  await page.waitForTimeout(200);

  // What the app has decided, before committing to it. Returned so a test can
  // assert on the decision rather than on the pixels that produced it.
  const merging =
    target.card === undefined
      ? false
      : await card(page, target.card).evaluate((el) => el.classList.contains('merge-target'));

  await page.mouse.up();
  await page.waitForTimeout(500);
  return merging;
}
