import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, signUp, setRole, body, type Harness } from '../test/harness.js';

/**
 * The stamp an open board polls.
 *
 * Its only job is to differ after something happened and to stay put when
 * nothing did — a false "no change" is a board that has quietly stopped
 * updating, which is worse than not polling at all.
 */

let h: Harness;
let admin: string;
let reporter: string;

before(async () => {
  h = await makeApp();
  admin = await signUp(h.app, 'boss@example.com');
  reporter = await signUp(h.app, 'reporter@example.com');
});
after(async () => h.close());

const as = (cookie: string) => ({ cookies: { todont_session: cookie } });

const stamp = async () =>
  body<{ stamp: string }>(await h.app.inject({ method: 'GET', url: '/api/board/version' })).stamp;

const raise = async (title: string) =>
  body<{ bug: { id: number } }>(
    await h.app.inject({ method: 'POST', url: '/api/bugs', ...as(reporter), payload: { title } }),
  ).bug.id;

test('the stamp is public, and is not cached', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/board/version' });

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['cache-control']), /no-store/);
  assert.equal(typeof body<{ stamp: string }>(res).stamp, 'string');
});

test('reading the board twice changes nothing', async () => {
  const first = await stamp();
  await h.app.inject({ method: 'GET', url: '/api/bugs' });
  assert.equal(await stamp(), first);
});

test('raising a bug moves it', async () => {
  const before = await stamp();
  await raise('Something new');
  assert.notEqual(await stamp(), before);
});

test('moving a bug moves it', async () => {
  const id = await raise('To be moved');
  const before = await stamp();

  await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    ...as(admin),
    payload: { status: 'backlog' },
  });

  assert.notEqual(await stamp(), before);
});

test('commenting moves it, even without an event of its own', async () => {
  const id = await raise('To be discussed');
  const before = await stamp();

  await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/comments`,
    ...as(reporter),
    payload: { body: 'A thought' },
  });

  assert.notEqual(await stamp(), before, 'a comment touches the bug and nothing else');
});

test('deleting a bug moves it, even though nothing is left to log', async () => {
  const id = await raise('To be deleted');
  const before = await stamp();

  const gone = await h.app.inject({ method: 'DELETE', url: `/api/bugs/${id}`, ...as(admin) });
  assert.equal(gone.statusCode, 200);

  assert.notEqual(await stamp(), before);
});

test('the poll carries the instance policy, so a change reaches open tabs', async () => {
  const before = body<{ live: { enabled: boolean; intervalSeconds: number; animate: boolean } }>(
    await h.app.inject({ method: 'GET', url: '/api/board/version' }),
  ).live;

  assert.equal(before.enabled, true);
  assert.equal(before.animate, true);

  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'live.enabled': false, 'live.animate': false },
  });

  const after = body<{ live: { enabled: boolean; animate: boolean } }>(
    await h.app.inject({ method: 'GET', url: '/api/board/version' }),
  ).live;

  assert.equal(after.enabled, false, 'a tab already open would keep polling');
  assert.equal(after.animate, false);

  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'live.enabled': true, 'live.animate': true },
  });
});

test('an interval below the floor is raised to it, not obeyed', async () => {
  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'live.intervalSeconds': 1 },
  });

  const { live } = body<{ live: { intervalSeconds: number } }>(
    await h.app.inject({ method: 'GET', url: '/api/board/version' }),
  );

  assert.equal(live.intervalSeconds, 5, 'every open tab would be hammering the box');
});

test('only an admin can change how the board polls', async () => {
  const res = await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(reporter),
    payload: { 'live.enabled': false },
  });
  assert.equal(res.statusCode, 403);

  // and being a manager is not enough either
  await setRole(h.app, admin, 2, 'manager');
  const asManager = await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(reporter),
    payload: { 'live.enabled': false },
  });
  assert.equal(asManager.statusCode, 403);
});

test('meta carries the same policy, for a tab that has just opened', async () => {
  const meta = body<{ live: { enabled: boolean; intervalSeconds: number } }>(
    await h.app.inject({ method: 'GET', url: '/api/meta' }),
  );

  assert.equal(typeof meta.live.enabled, 'boolean');
  assert.ok(meta.live.intervalSeconds >= 5);
});
