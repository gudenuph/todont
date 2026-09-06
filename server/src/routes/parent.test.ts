import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { makeApp, signUp, body, type Harness } from '../test/harness.js';

/**
 * Parent tickets: one parent each, any number of sub-tickets, no loops.
 */

let h: Harness;
let admin: string; // the first account is admin, which implies manage
let reporter: string;

before(async () => {
  h = await makeApp();
  admin = await signUp(h.app, 'boss@example.com', 'a good enough password', 'Boss');
  reporter = await signUp(h.app, 'reporter@example.com', 'a good enough password', 'Reporter');
});
after(async () => h.close());

const raise = async (app: FastifyInstance, cookie: string, payload: Record<string, unknown>) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/bugs',
    cookies: { todont_session: cookie },
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  return body<{ bug: { id: number } }>(res).bug.id;
};

const setParent = (child: number, parent: number, cookie = admin) =>
  h.app.inject({
    method: 'POST',
    url: `/api/bugs/${child}/parent`,
    cookies: { todont_session: cookie },
    payload: { parentId: parent },
  });

const clearParent = (child: number, cookie = admin) =>
  h.app.inject({
    method: 'DELETE',
    url: `/api/bugs/${child}/parent`,
    cookies: { todont_session: cookie },
  });

interface Related {
  id: number;
  title: string;
  status: string;
}

interface Detail {
  id: number;
  parentId: number | null;
  childCount: number;
  parent: Related | null;
  children: Related[];
  childrenDone: number;
  events: Array<{ type: string; detail: string }>;
}

const detail = async (id: number) =>
  body<{ bug: Detail }>(await h.app.inject({ method: 'GET', url: `/api/bugs/${id}` })).bug;

test('a manager sets and clears a parent, and both tickets log it', async () => {
  const epic = await raise(h.app, admin, { title: 'Epic' });
  const part = await raise(h.app, admin, { title: 'One part of it' });

  const set = await setParent(part, epic);
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(body<{ bug: Detail }>(set).bug.parentId, epic);

  let child = await detail(part);
  let parent = await detail(epic);
  assert.equal(child.parent?.id, epic);
  assert.deepEqual(parent.children.map((c) => c.id), [part]);
  assert.ok(child.events.some((e) => e.type === 'parent_set'), 'the child says it was filed under');
  assert.ok(parent.events.some((e) => e.type === 'child_added'), 'the parent says it gained one');

  const cleared = await clearParent(part);
  assert.equal(cleared.statusCode, 200, cleared.body);

  child = await detail(part);
  parent = await detail(epic);
  assert.equal(child.parentId, null);
  assert.equal(child.parent, null);
  assert.deepEqual(parent.children, []);
  assert.ok(child.events.some((e) => e.type === 'parent_cleared'));
  assert.ok(parent.events.some((e) => e.type === 'child_removed'));

  // Nothing left to clear.
  assert.equal((await clearParent(part)).statusCode, 404);
});

test('a ticket cannot be its own parent', async () => {
  const id = await raise(h.app, admin, { title: 'Alone' });
  assert.equal((await setParent(id, id)).statusCode, 400);
});

test('loops are refused however long the chain', async () => {
  const a = await raise(h.app, admin, { title: 'A' });
  const b = await raise(h.app, admin, { title: 'B' });
  const c = await raise(h.app, admin, { title: 'C' });

  assert.equal((await setParent(b, a)).statusCode, 200, 'b under a');
  assert.equal((await setParent(c, b)).statusCode, 200, 'c under b');

  // a under c would close a -> b -> c -> a
  assert.equal((await setParent(a, c)).statusCode, 409, 'the loop is refused');
  // and the direct case
  assert.equal((await setParent(a, b)).statusCode, 409);

  // Moving c straight under a is fine: it only shortens the chain.
  assert.equal((await setParent(c, a)).statusCode, 200);
  assert.deepEqual((await detail(a)).children.map((t) => t.id), [b, c]);
  assert.deepEqual((await detail(b)).children, [], 'c left b when it moved');
});

test('a merged ticket can neither be a parent nor be given one', async () => {
  const keep = await raise(h.app, admin, { title: 'Kept' });
  const dup = await raise(h.app, admin, { title: 'Duplicate' });
  const other = await raise(h.app, admin, { title: 'Other' });

  const merge = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${dup}/merge`,
    cookies: { todont_session: admin },
    payload: { intoId: keep },
  });
  assert.equal(merge.statusCode, 200, merge.body);

  assert.equal((await setParent(other, dup)).statusCode, 409, 'not under a duplicate');
  assert.equal((await setParent(dup, other)).statusCode, 409, 'a duplicate goes nowhere');
});

test('a parent that does not exist is refused', async () => {
  const id = await raise(h.app, admin, { title: 'Orphan' });
  assert.equal((await setParent(id, 999_999)).statusCode, 404);
});

test('setting a parent needs manage, on every route that takes one', async () => {
  const epic = await raise(h.app, admin, { title: 'Manager territory' });
  const own = await raise(h.app, reporter, { title: 'My own report' });

  assert.equal((await setParent(own, epic, reporter)).statusCode, 403);

  // The reporter may still edit their own untriaged text, but not file it.
  const patch = await h.app.inject({
    method: 'PATCH',
    url: `/api/bugs/${own}`,
    cookies: { todont_session: reporter },
    payload: { parentId: epic },
  });
  assert.equal(patch.statusCode, 403);

  const create = await h.app.inject({
    method: 'POST',
    url: '/api/bugs',
    cookies: { todont_session: reporter },
    payload: { title: 'Filed under', parentId: epic },
  });
  assert.equal(create.statusCode, 403);

  assert.equal((await detail(own)).parentId, null);
  assert.equal((await detail(epic)).childCount, 0);
});

test('a parent can be given at creation and changed through PATCH', async () => {
  const epic = await raise(h.app, admin, { title: 'Filed at birth' });
  const second = await raise(h.app, admin, { title: 'Second home' });

  const created = await h.app.inject({
    method: 'POST',
    url: '/api/bugs',
    cookies: { todont_session: admin },
    payload: { title: 'Born a sub-ticket', parentId: epic },
  });
  assert.equal(created.statusCode, 201, created.body);
  const child = body<{ bug: Detail }>(created).bug;
  assert.equal(child.parentId, epic);
  assert.equal((await detail(epic)).childCount, 1);

  const moved = await h.app.inject({
    method: 'PATCH',
    url: `/api/bugs/${child.id}`,
    cookies: { todont_session: admin },
    payload: { parentId: second },
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(body<{ bug: Detail }>(moved).bug.parentId, second);
  assert.equal((await detail(epic)).childCount, 0, 'the old parent let go');

  const cleared = await h.app.inject({
    method: 'PATCH',
    url: `/api/bugs/${child.id}`,
    cookies: { todont_session: admin },
    payload: { parentId: null, title: 'Renamed and released' },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(body<{ bug: Detail }>(cleared).bug.parentId, null);
  assert.equal((await detail(second)).childCount, 0);
});

test('cards carry the count, the detail carries the list, and both skip merged children', async () => {
  const epic = await raise(h.app, admin, { title: 'Counted' });
  const one = await raise(h.app, admin, { title: 'Sub one' });
  const two = await raise(h.app, admin, { title: 'Sub two' });
  const three = await raise(h.app, admin, { title: 'Sub three, a duplicate of two' });
  for (const id of [one, two, three]) assert.equal((await setParent(id, epic)).statusCode, 200);

  await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${three}/merge`,
    cookies: { todont_session: admin },
    payload: { intoId: two },
  });

  const board = body<{ bugs: Array<{ id: number; parentId: number | null; childCount: number }> }>(
    await h.app.inject({ method: 'GET', url: '/api/bugs' }),
  ).bugs;

  assert.equal(board.find((b) => b.id === epic)?.childCount, 2);
  assert.equal(board.find((b) => b.id === one)?.parentId, epic);

  const parent = await detail(epic);
  assert.deepEqual(parent.children.map((c) => c.id), [one, two]);
  assert.equal(parent.childrenDone, 0);

  // Progress counts children in a terminal lane.
  await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${one}/move`,
    cookies: { todont_session: admin },
    payload: { status: 'shipped' },
  });
  assert.equal((await detail(epic)).childrenDone, 1);
});

test('the board can be filtered to one parent’s sub-tickets', async () => {
  const epic = await raise(h.app, admin, { title: 'Filter me' });
  const mine = await raise(h.app, admin, { title: 'Under it' });
  await raise(h.app, admin, { title: 'Not under it' });
  assert.equal((await setParent(mine, epic)).statusCode, 200);

  const res = await h.app.inject({ method: 'GET', url: `/api/bugs?parentId=${epic}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    body<{ bugs: Array<{ id: number }> }>(res).bugs.map((b) => b.id),
    [mine],
  );

  assert.equal((await h.app.inject({ method: 'GET', url: '/api/bugs?parentId=x' })).statusCode, 400);
});

test('deleting a parent releases its sub-tickets rather than taking them with it', async () => {
  const epic = await raise(h.app, admin, { title: 'Doomed' });
  const survivor = await raise(h.app, admin, { title: 'Survives' });
  assert.equal((await setParent(survivor, epic)).statusCode, 200);

  const gone = await h.app.inject({
    method: 'DELETE',
    url: `/api/bugs/${epic}`,
    cookies: { todont_session: admin },
  });
  assert.equal(gone.statusCode, 200, gone.body);

  const child = await detail(survivor);
  assert.equal(child.parentId, null);
  assert.equal(child.parent, null);
});
