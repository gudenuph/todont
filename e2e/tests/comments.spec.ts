import { test, expect, raise } from '../fixtures';

/**
 * Images on comments. The parts worth testing in a browser are the ones no
 * server test reaches: that a picture chosen in the form actually arrives, and
 * that it renders in the thread rather than in the bug's own gallery.
 */

/** One transparent pixel — a real PNG, small enough to inline. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const file = (name = 'screenshot.png') => ({ name, mimeType: 'image/png', buffer: PNG });

test('a comment posted with an image shows the image in the thread', async ({
  adminPage: page,
  api,
}) => {
  const id = await raise(api, { title: 'Needs a picture' });

  await page.goto(`/#/bug/${id}`);
  await page.locator('.composer textarea').fill('It looks like this:');
  await page.locator('.composer input[type=file]').setInputFiles(file());

  // Staged, not sent — and visibly so.
  await expect(page.locator('.comment-shots.staged .comment-shot')).toHaveCount(1);

  await page.getByRole('button', { name: 'Comment' }).click();

  // Believe the server: reload, then look.
  await page.reload();
  const comment = page.locator('.comment').last();
  await expect(comment).toContainText('It looks like this:');
  await expect(comment.locator('.comment-shot img')).toHaveCount(1);

  // The image really loads rather than showing a broken icon.
  const ok = await comment.locator('.comment-shot img').evaluate(
    (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
  );
  expect(ok, 'the image did not load').toBe(true);
});

test('a comment image stays out of the bug gallery', async ({ adminPage: page, api }) => {
  const id = await raise(api, { title: 'Gallery stays empty' });

  await page.goto(`/#/bug/${id}`);
  await page.locator('.composer textarea').fill('Only on the comment');
  await page.locator('.composer input[type=file]').setInputFiles(file());
  await page.getByRole('button', { name: 'Comment' }).click();

  await page.reload();
  await expect(page.locator('.comment-shot')).toHaveCount(1);
  // The bug's own Attachments section is not rendered when it holds nothing.
  await expect(page.locator('.shots')).toHaveCount(0);
});

test('a picture on its own is enough to comment', async ({ adminPage: page, api }) => {
  const id = await raise(api, { title: 'Wordless' });

  await page.goto(`/#/bug/${id}`);
  const send = page.getByRole('button', { name: 'Comment' });

  // Nothing typed and nothing staged: there is nothing to send.
  await expect(send).toBeDisabled();

  await page.locator('.composer input[type=file]').setInputFiles(file());
  await expect(send).toBeEnabled();

  await send.click();
  await page.reload();
  await expect(page.locator('.comment .comment-shot img')).toHaveCount(1);
});

test('a staged image can be taken back before sending', async ({ adminPage: page, api }) => {
  const id = await raise(api, { title: 'Changed my mind' });

  await page.goto(`/#/bug/${id}`);
  await page.locator('.composer input[type=file]').setInputFiles([file('a.png'), file('b.png')]);
  await expect(page.locator('.comment-shots.staged .comment-shot')).toHaveCount(2);

  await page.locator('.comment-shots.staged .shot-remove').first().click();
  await expect(page.locator('.comment-shots.staged .comment-shot')).toHaveCount(1);

  await page.locator('.composer textarea').fill('Just the one');
  await page.getByRole('button', { name: 'Comment' }).click();

  await page.reload();
  await expect(page.locator('.comment .comment-shot')).toHaveCount(1);
});

test('somebody not signed in sees comment images but gets no composer', async ({
  page,
  adminPage,
  api,
}) => {
  const id = await raise(api, { title: 'Public reading' });

  await adminPage.goto(`/#/bug/${id}`);
  await adminPage.locator('.composer textarea').fill('For everyone to see');
  await adminPage.locator('.composer input[type=file]').setInputFiles(file());
  await adminPage.getByRole('button', { name: 'Comment' }).click();
  await expect(adminPage.locator('.comment .comment-shot')).toHaveCount(1);

  await page.goto(`/#/bug/${id}`);
  await expect(page.locator('.comment .comment-shot img')).toHaveCount(1);
  await expect(page.locator('.composer')).toHaveCount(0);
});
