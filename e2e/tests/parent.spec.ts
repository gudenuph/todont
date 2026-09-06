import { test, expect, raise, card } from '../fixtures';

/**
 * Parent tickets: an epic and its sub-tickets, from both ends and on the board.
 */

async function file(api: Parameters<typeof raise>[0], child: number, parent: number) {
  const res = await api.post(`/api/bugs/${child}/parent`, { data: { parentId: parent } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test('the board badges a parent with its count and a sub-ticket with its parent', async ({
  page,
  api,
}) => {
  const epic = await raise(api, { title: 'An epic' });
  const one = await raise(api, { title: 'First part' });
  const two = await raise(api, { title: 'Second part' });
  await file(api, one, epic);
  await file(api, two, epic);

  await page.goto('/');

  await expect(card(page, epic).locator('.pill.sub')).toHaveText('⊞ 2');
  await expect(card(page, one).locator('.pill.parent')).toHaveText(`↑ #${epic}`);
  await expect(card(page, epic).locator('.pill.parent')).toHaveCount(0);
  await expect(card(page, one).locator('.pill.sub')).toHaveCount(0);
});

test('a manager files a ticket under another from the ticket, and unfiles it', async ({
  adminPage: page,
  api,
}) => {
  const epic = await raise(api, { title: 'Holds the parts' });
  const part = await raise(api, { title: 'Is one of the parts' });

  await page.goto(`/#/bug/${part}`);
  await expect(page.locator('.modal.wide')).toBeVisible();

  await page.locator('select[aria-label="File under"]').selectOption(String(epic));
  await page.getByRole('button', { name: 'File', exact: true }).click();

  const partOf = page.locator('.kin-group').first();
  await expect(partOf.locator('.dep-chip')).toContainText(`#${epic}`);

  // The other end shows on the parent, with progress.
  await page.goto(`/#/bug/${epic}`);
  const subs = page.locator('.kin-group').last();
  await expect(subs.locator('.dep-chip')).toContainText(`#${part}`);
  await expect(page.locator('.kin-progress')).toHaveText('0 of 1 done');

  // Unfiling from the parent's end drops it.
  await subs.locator('.dep-remove').click();
  await expect(subs.locator('.dep-chip')).toHaveCount(0);
  await expect(page.locator('.kin-progress')).toHaveCount(0);
});

test('"+ New sub-ticket" raises one already filed under the parent', async ({
  adminPage: page,
  api,
}) => {
  const epic = await raise(api, { title: 'Wants a new part' });

  await page.goto(`/#/bug/${epic}`);
  await page.getByRole('button', { name: '+ New sub-ticket' }).click();

  const form = page.locator('.modal').filter({ hasText: 'Raise a' });
  await expect(form.locator('.prefill-note')).toContainText(`sub-ticket of #${epic}`);

  await form.locator('#nb-title').fill('The new part');
  await form.getByRole('button', { name: /^Raise/ }).click();

  // Raising opens the new ticket, which says where it lives.
  await expect(page.locator('.modal.wide')).toBeVisible();
  await expect(page.locator('.modal.wide .modal-head h2')).toHaveText('The new part');
  await expect(page.locator('.kin-group').first().locator('.dep-chip')).toContainText(`#${epic}`);
});

test('somebody without manage sees the hierarchy but cannot change it', async ({
  plainPage: page,
  api,
}) => {
  const epic = await raise(api, { title: 'Read-only parent' });
  const part = await raise(api, { title: 'Read-only part' });
  await file(api, part, epic);

  await page.goto(`/#/bug/${part}`);

  await expect(page.locator('.kin-group').first().locator('.dep-chip')).toContainText(`#${epic}`);
  await expect(page.locator('.dep-remove')).toHaveCount(0);
  await expect(page.locator('select[aria-label="File under"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New sub-ticket' })).toHaveCount(0);
});

test('a #number in a description opens that ticket', async ({ page, api }) => {
  const target = await raise(api, { title: 'The one being pointed at' });
  const pointer = await raise(api, { title: 'Points elsewhere', description: `See #${target} first.` });

  await page.goto(`/#/bug/${pointer}`);
  await page.locator('.ref-link', { hasText: `#${target}` }).click();

  await expect(page.locator('.modal.wide .modal-head h2')).toHaveText('The one being pointed at');
});
