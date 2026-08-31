import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  makeApp,
  multipart,
  setRole,
  signUp,
  body,
  ONE_PIXEL_PNG,
  type Harness,
} from '../test/harness.js';

/** Images on comments — the one-request form, the add-later form, and cleanup. */

let h: Harness;
let admin: string;
let reporter: string;
let other: string;
let uploads: string;

before(async () => {
  h = await makeApp();
  admin = await signUp(h.app, 'boss@example.com', 'a good enough password', 'Boss');
  reporter = await signUp(h.app, 'reporter@example.com', 'a good enough password', 'Reporter');
  other = await signUp(h.app, 'other@example.com', 'a good enough password', 'Other');
  uploads = path.join(h.dir, 'uploads');
});
after(async () => h.close());

const as = (cookie: string) => ({ cookies: { todont_session: cookie } });

interface Detail {
  attachmentCount: number;
  attachments: Array<{ id: number; url: string; mime: string }>;
  comments: Array<{
    id: number;
    body: string;
    attachments: Array<{ id: number; url: string; name: string; mime: string }>;
  }>;
}

async function newBug(): Promise<number> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/bugs',
    ...as(reporter),
    payload: { title: 'Something looks wrong' },
  });
  return body<{ bug: { id: number } }>(res).bug.id;
}

/** A comment with files, in one request — the shape the form and the API use. */
const commentWith = (
  bug: number,
  cookie: string,
  text: string | null,
  files: number,
  mime = 'image/png',
) =>
  h.app.inject({
    method: 'POST',
    url: `/api/bugs/${bug}/comments`,
    ...as(cookie),
    ...multipart([
      ...(text === null ? [] : [{ field: 'body', value: text }]),
      ...Array.from({ length: files }, (_, i) => ({
        file: 'file',
        filename: `shot${i}.png`,
        mime,
        content: ONE_PIXEL_PNG,
      })),
    ]),
  });

test('a comment and its images arrive in one request', async () => {
  const bug = await newBug();

  const res = await commentWith(bug, reporter, 'It looks like this:', 2);
  assert.equal(res.statusCode, 201, res.body);

  const detail = body<{ bug: Detail }>(res).bug;
  const comment = detail.comments.at(-1)!;

  assert.equal(comment.body, 'It looks like this:');
  assert.equal(comment.attachments.length, 2);
  assert.equal(comment.attachments[0].mime, 'image/png');

  // and the bytes are really served
  const fetched = await h.app.inject({ method: 'GET', url: comment.attachments[0].url });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.headers['content-type'], 'image/png');
  assert.deepEqual(fetched.rawPayload, ONE_PIXEL_PNG);
});

test('a comment image does not land in the bug gallery, or in its count', async () => {
  const bug = await newBug();
  await commentWith(bug, reporter, 'Here', 1);

  const detail = body<{ bug: Detail }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bug}` }),
  ).bug;

  assert.equal(detail.attachments.length, 0, 'the gallery is for the bug itself');
  assert.equal(detail.attachmentCount, 0, 'the badge should agree with the gallery');
  assert.equal(detail.comments[0].attachments.length, 1);
});

test('a picture on its own is a comment; nothing at all is not', async () => {
  const bug = await newBug();

  const wordless = await commentWith(bug, reporter, null, 1);
  assert.equal(wordless.statusCode, 201, wordless.body);
  assert.equal(body<{ bug: Detail }>(wordless).bug.comments.at(-1)!.body, '');

  const empty = await commentWith(bug, reporter, '   ', 0);
  assert.equal(empty.statusCode, 400);
});

test('plain JSON comments still work', async () => {
  const bug = await newBug();

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${bug}/comments`,
    ...as(reporter),
    payload: { body: 'No pictures, thanks' },
  });

  assert.equal(res.statusCode, 201);
  const comment = body<{ bug: Detail }>(res).bug.comments.at(-1)!;
  assert.equal(comment.body, 'No pictures, thanks');
  assert.deepEqual(comment.attachments, []);
});

test('images can be added to a comment that already exists', async () => {
  const bug = await newBug();
  const posted = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${bug}/comments`,
    ...as(reporter),
    payload: { body: 'Forgot the screenshot' },
  });
  const commentId = body<{ bug: Detail }>(posted).bug.comments.at(-1)!.id;

  const add = (cookie: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/comments/${commentId}/attachments`,
      ...as(cookie),
      ...multipart([
        { file: 'file', filename: 'late.png', mime: 'image/png', content: ONE_PIXEL_PNG },
      ]),
    });

  // Somebody else's comment is not yours to illustrate.
  assert.equal((await add(other)).statusCode, 403);

  const mine = await add(reporter);
  assert.equal(mine.statusCode, 201, mine.body);
  assert.equal(body<{ bug: Detail }>(mine).bug.comments.at(-1)!.attachments.length, 1);

  // A manager can, on anyone's.
  const boss = await add(admin);
  assert.equal(boss.statusCode, 201);
  assert.equal(body<{ bug: Detail }>(boss).bug.comments.at(-1)!.attachments.length, 2);
});

test('deleting a comment takes its images off the disk', async () => {
  const bug = await newBug();
  const res = await commentWith(bug, reporter, 'Look at this', 2);
  const comment = body<{ bug: Detail }>(res).bug.comments.at(-1)!;

  const before = await fs.readdir(uploads);
  assert.ok(before.length >= 2);

  // Manager-only, as it always was.
  assert.equal(
    (await h.app.inject({ method: 'DELETE', url: `/api/comments/${comment.id}`, ...as(other) }))
      .statusCode,
    403,
  );

  const gone = await h.app.inject({
    method: 'DELETE',
    url: `/api/comments/${comment.id}`,
    ...as(admin),
  });
  assert.equal(gone.statusCode, 200);

  const after = await fs.readdir(uploads);
  assert.equal(after.length, before.length - 2, 'the files are still on disk');

  // and the rows went with it
  assert.equal(
    (await h.app.inject({ method: 'GET', url: comment.attachments[0].url })).statusCode,
    404,
  );
});

test('a refused upload leaves nothing behind', async () => {
  const bug = await newBug();
  const before = await fs.readdir(uploads);

  // One good file, then one the server will not take: the first is already
  // written by the time the second is rejected.
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${bug}/comments`,
    ...as(reporter),
    ...multipart([
      { field: 'body', value: 'Mixed' },
      { file: 'file', filename: 'fine.png', mime: 'image/png', content: ONE_PIXEL_PNG },
      { file: 'file', filename: 'nasty.svg', mime: 'image/svg+xml', content: Buffer.from('<svg/>') },
    ]),
  });

  assert.equal(res.statusCode, 415);
  assert.deepEqual(await fs.readdir(uploads), before, 'a half-written upload was kept');

  // and no comment was created either
  const detail = body<{ bug: Detail }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bug}` }),
  ).bug;
  assert.equal(detail.comments.length, 0);
});

test('someone signed out cannot comment with images', async () => {
  const bug = await newBug();
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${bug}/comments`,
    ...multipart([
      { file: 'file', filename: 'a.png', mime: 'image/png', content: ONE_PIXEL_PNG },
    ]),
  });
  assert.equal(res.statusCode, 401);
});

test('deleting the bug takes comment images with it', async () => {
  const bug = await newBug();
  await commentWith(bug, reporter, 'Evidence', 2);

  const before = await fs.readdir(uploads);
  await setRole(h.app, admin, 2, 'manager');

  const gone = await h.app.inject({ method: 'DELETE', url: `/api/bugs/${bug}`, ...as(admin) });
  assert.equal(gone.statusCode, 200);

  assert.equal((await fs.readdir(uploads)).length, before.length - 2);
});
