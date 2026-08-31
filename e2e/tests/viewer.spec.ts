import { test, expect, raise } from '../fixtures';

/**
 * An open ticket: staying current while you read it, and looking at a picture
 * properly rather than in a thumbnail the width of a card.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const file = (name = 'shot.png') => ({ name, mimeType: 'image/png', buffer: PNG });

/** Post a comment as somebody else, with optional images. */
async function commentAs(
  api: import('@playwright/test').APIRequestContext,
  id: number,
  body: string,
  images = 0,
) {
  const res = await api.post(`/api/bugs/${id}/comments`, {
    multipart: {
      body,
      ...Object.fromEntries(
        Array.from({ length: images }, (_, i) => [
          'file',
          { name: `c${i}.png`, mimeType: 'image/png', buffer: PNG },
        ]),
      ),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.beforeEach(async ({ api }) => {
  await api.patch('/api/admin/instance', {
    data: { 'live.enabled': true, 'live.intervalSeconds': 5 },
  });
});

test('a comment made while you are reading appears, and says it is new', async ({
  adminPage: page,
  api,
}) => {
  const id = await raise(api, { title: 'Being read right now' });

  await page.goto(`/#/bug/${id}`);
  await expect(page.locator('.modal.wide h2')).toHaveText('Being read right now');
  await expect(page.locator('.comment')).toHaveCount(0);

  await commentAs(api, id, 'Said while you had it open');

  await expect(page.locator('.comment')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('.comment')).toContainText('Said while you had it open');
  await expect(page.locator('.comment')).toHaveClass(/just-arrived/);

  // The announcement clears itself; the comment stays.
  await expect(page.locator('.comment')).not.toHaveClass(/just-arrived/, { timeout: 15_000 });
  await expect(page.locator('.comment')).toHaveCount(1);
});

test('an image added to the ticket while it is open turns up too', async ({
  adminPage: page,
  api,
}) => {
  const id = await raise(api, { title: 'Gaining a picture' });

  await page.goto(`/#/bug/${id}`);
  await expect(page.locator('.modal.wide h2')).toBeVisible();
  await expect(page.locator('.comment-shot')).toHaveCount(0);

  await commentAs(api, id, 'Here it is', 1);

  await expect(page.locator('.comment-shot img')).toHaveCount(1, { timeout: 20_000 });
});

test('an edit in progress is not overwritten underneath you', async ({ adminPage: page, api }) => {
  const id = await raise(api, { title: 'Do not clobber me' });

  await page.goto(`/#/bug/${id}`);
  await page.getByRole('button', { name: 'Edit' }).click();

  const title = page.locator('.title-edit');
  await expect(title).toBeVisible();
  await title.fill('Half-typed thought');

  // Somebody else changes the ticket while the form is open.
  await commentAs(api, id, 'Meanwhile, elsewhere');
  await page.waitForTimeout(12_000);

  // What was typed is still there.
  await expect(title).toHaveValue('Half-typed thought');
});

test('clicking an attachment opens it full size, and Escape closes it', async ({
  adminPage: page,
  api,
}) => {
  const id = await raise(api, { title: 'Has a screenshot' });

  const uploaded = await api.post(`/api/bugs/${id}/attachments`, {
    multipart: { file: file('evidence.png') },
  });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();

  await page.goto(`/#/bug/${id}`);
  await page.locator('.shots img').first().click();

  const box = page.locator('.lightbox');
  await expect(box).toBeVisible();
  await expect(box.locator('.lightbox-image')).toBeVisible();
  await expect(box).toContainText('evidence.png');

  // Clicking the picture itself must not close what you opened to look at.
  await box.locator('.lightbox-image').click();
  await expect(box).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);

  // and the ticket is still open behind it
  await expect(page.locator('.modal.wide h2')).toHaveText('Has a screenshot');
});

test('the backdrop closes it, and the ticket underneath stays open', async ({
  adminPage: page,
  api,
}) => {
  const id = await raise(api, { title: 'Backdrop test' });
  await api.post(`/api/bugs/${id}/attachments`, { multipart: { file: file() } });

  await page.goto(`/#/bug/${id}`);
  await page.locator('.shots img').first().click();
  await expect(page.locator('.lightbox')).toBeVisible();

  // Top-left corner: backdrop, well clear of the image and the buttons.
  await page.locator('.lightbox').click({ position: { x: 8, y: 200 } });

  await expect(page.locator('.lightbox')).toHaveCount(0);
  await expect(page.locator('.modal.wide h2')).toHaveText('Backdrop test');
});

test('a comment image opens full size, and the arrows walk the whole ticket', async ({
  adminPage: page,
  api,
}) => {
  const id = await raise(api, { title: 'Several pictures' });
  await api.post(`/api/bugs/${id}/attachments`, { multipart: { file: file('gallery.png') } });

  await page.goto(`/#/bug/${id}`);
  await page.locator('.composer textarea').fill('And one on the comment');
  await page.locator('.composer input[type=file]').setInputFiles(file('thread.png'));
  await page.getByRole('button', { name: 'Comment' }).click();
  await expect(page.locator('.comment-shot img')).toHaveCount(1);

  // Open the one in the thread; the gallery's is still reachable from it.
  await page.locator('.comment-shot img').click();
  const box = page.locator('.lightbox');
  await expect(box).toContainText('thread.png');
  await expect(box).toContainText('2 of 2');

  await page.keyboard.press('ArrowRight');
  await expect(box).toContainText('gallery.png');
  await expect(box).toContainText('1 of 2');

  await page.keyboard.press('ArrowLeft');
  await expect(box).toContainText('thread.png');
});

test('a single image gets no arrows to press', async ({ adminPage: page, api }) => {
  const id = await raise(api, { title: 'Only one' });
  await api.post(`/api/bugs/${id}/attachments`, { multipart: { file: file() } });

  await page.goto(`/#/bug/${id}`);
  await page.locator('.shots img').first().click();

  await expect(page.locator('.lightbox')).toBeVisible();
  await expect(page.locator('.lightbox-step')).toHaveCount(0);
  await expect(page.locator('.lightbox-count')).toHaveCount(0);
});
