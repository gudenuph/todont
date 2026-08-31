import { test, expect, raise, card } from '../fixtures';

/** The panel, and whether what it changes reaches the board. */

test('renaming a lane changes the heading and moves no tickets', async ({ adminPage: page, api }) => {
  const id = await raise(api, { title: 'Stays put through a rename' });

  await page.goto('/');
  await page.getByRole('button', { name: 'Admin' }).click();
  await page.locator('.tab', { hasText: 'Lanes' }).click();

  const row = page.locator('.table.lanes tbody tr').first();
  await row.locator('input[type=text]').fill('Inbox');
  await row.locator('input[type=text]').blur();
  await page.waitForTimeout(600);
  await page.locator('.close').click();

  await expect(page.locator('.column-head h2').first()).toHaveText('Inbox');
  await expect(card(page, id)).toBeVisible();

  // put it back for the tests that follow
  await page.getByRole('button', { name: 'Admin' }).click();
  await page.locator('.tab', { hasText: 'Lanes' }).click();
  const again = page.locator('.table.lanes tbody tr').first();
  await again.locator('input[type=text]').fill('Unconfirmed');
  await again.locator('input[type=text]').blur();
  await page.waitForTimeout(600);
});

test('the board name reaches the top bar and the browser tab', async ({ adminPage: page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Admin' }).click();

  await page.locator('#ad-name').fill('Acme Tracker');
  await page.locator('#ad-tagline').fill('what we broke');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(700);
  await page.locator('.close').click();

  await expect(page.locator('.brand')).toContainText('Acme Tracker');
  await expect(page.locator('.brand')).toContainText('what we broke');
  await expect(page).toHaveTitle('Acme Tracker');
});

test('an admin cannot switch off the way they signed in', async ({ adminPage: page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Admin' }).click();
  await page.locator('.tab', { hasText: 'Sign-in' }).click();

  const emailAndPassword = page.locator('.checks .check input').first();
  await expect(emailAndPassword).toBeChecked();
  await emailAndPassword.click();

  await expect(page.locator('.modal .error')).toContainText(/lock you out/i);
  await expect(emailAndPassword).toBeChecked();
});

test('checkbox rows have room between the box and the words', async ({ adminPage: page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Admin' }).click();
  await page.locator('.tab', { hasText: 'Sign-in' }).click();

  // Regression: `.field label` once outranked `.check` and collapsed the gap.
  const gaps = await page.locator('.check').evaluateAll((labels) =>
    labels.map((label) => {
      const box = label.querySelector('input')!.getBoundingClientRect();
      const range = document.createRange();
      const text = [...label.childNodes].find(
        (n) => n.nodeType === 3 && n.textContent!.trim(),
      );
      if (!text) return null;
      range.selectNode(text);
      return Math.round(range.getBoundingClientRect().left - box.right);
    }),
  );

  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(6);
});

test('a token is minted from the panel and shown exactly once', async ({ adminPage: page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Admin' }).click();
  await page.locator('.tab', { hasText: 'API tokens' }).click();

  await page.locator('#tk-name').fill('a-test-token');
  await page.getByRole('button', { name: 'Create token' }).click();

  const shown = page.locator('.token-reveal code');
  await expect(shown).toContainText(/^ezb_/);
  const secret = await shown.textContent();

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.token-reveal')).toHaveCount(0);

  // Reloading must not bring it back; only its name and permissions remain.
  await page.reload();
  await page.getByRole('button', { name: 'Admin' }).click();
  await page.locator('.tab', { hasText: 'API tokens' }).click();
  await expect(page.locator('.table')).toContainText('a-test-token');
  await expect(page.locator('.modal-body')).not.toContainText(secret!);
});
