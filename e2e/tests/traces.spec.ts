import { test, expect, raise } from '../fixtures';

const B = String.fromCharCode(92);
const TRACE =
  'System.NullReferenceException: Object reference not set to an instance of an object.' +
  `\n   at Mixer.SetGain(Single v) in C:${B}Users${B}ada${B}src${B}Mixer.cs:line 88`;

test('a stack trace shows for a manager and not for anybody else', async ({
  adminPage,
  plainPage,
  api,
}) => {
  const id = await raise(api, { title: 'Crashes on gain', stackTrace: TRACE });

  await adminPage.goto(`/#/bug/${id}`);
  await expect(adminPage.locator('pre.stack')).toContainText('NullReferenceException');
  await expect(adminPage.locator('pre.stack')).toContainText('<HOME>');
  await expect(adminPage.locator('pre.stack')).not.toContainText('ada');

  await plainPage.goto(`/#/bug/${id}`);
  await expect(plainPage.locator('pre.stack')).toHaveCount(0);
  // The section is still there — knowing a trace arrived is not a secret.
  const section = plainPage.locator('.detail-section').filter({
    has: plainPage.locator('h3', { hasText: 'Stack trace' }),
  });
  await expect(section).toContainText(/Managers can read it/i);
});

test('a long trace scrolls inside its box instead of stretching the dialog', async ({
  adminPage: page,
  api,
}) => {
  const long =
    'System.Exception: ' + 'x'.repeat(400) + `\n   at Somewhere.Deep.In.The.Stack(Int32 i)`;
  const id = await raise(api, { title: 'Very wide trace', stackTrace: long });

  await page.goto(`/#/bug/${id}`);
  const modal = await page.locator('.modal.wide').boundingBox();
  const viewport = page.viewportSize()!;

  // Regression: a grid item defaults to min-width:auto, and one unbreakable
  // line used to drag the whole dialog off the screen.
  expect(modal!.x).toBeGreaterThanOrEqual(0);
  expect(modal!.x + modal!.width).toBeLessThanOrEqual(viewport.width + 1);

  const scrolls = await page
    .locator('pre.stack')
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrolls, 'the trace scrolls on its own').toBe(true);
});
