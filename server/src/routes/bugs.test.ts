import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { makeApp, setRole, signUp, body, type Harness } from '../test/harness.js';

let h: Harness;
let admin: string; // also a manager: admin implies manage
let reporter: string;

before(async () => {
  h = await makeApp();
  admin = await signUp(h.app, 'boss@example.com', 'a good enough password', 'Boss');
  reporter = await signUp(h.app, 'reporter@example.com', 'a good enough password', 'Reporter');
});
after(async () => h.close());

const raise = (app: FastifyInstance, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/bugs', cookies: { todont_session: cookie }, payload });

test('anyone signed in can raise a bug; anonymous cannot', async () => {
  const mine = await raise(h.app, reporter, { title: 'Fader jumps to silence' });
  assert.equal(mine.statusCode, 201);

  const anon = await h.app.inject({
    method: 'POST',
    url: '/api/bugs',
    payload: { title: 'from nobody' },
  });
  assert.equal(anon.statusCode, 401);
});

test('the board is readable without signing in', async () => {
  const res = await h.app.inject({ method: 'GET', url: '/api/bugs' });
  assert.equal(res.statusCode, 200);
  assert.ok(body<{ bugs: unknown[] }>(res).bugs.length >= 1);
});

test('a new bug lands in the intake lane', async () => {
  const res = await raise(h.app, reporter, { title: 'Lands in intake' });
  assert.equal(body<{ bug: { status: string } }>(res).bug.status, 'unconfirmed');
});

test('only a manager can move a card', async () => {
  const id = body<{ bug: { id: number } }>(await raise(h.app, reporter, { title: 'To move' })).bug.id;

  const asReporter = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    cookies: { todont_session: reporter },
    payload: { status: 'confirmed' },
  });
  assert.equal(asReporter.statusCode, 403);

  const asAdmin = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    cookies: { todont_session: admin },
    payload: { status: 'confirmed' },
  });
  assert.equal(body<{ bug: { status: string } }>(asAdmin).bug.status, 'confirmed');
});

test('moving to a lane that does not exist is refused', async () => {
  const id = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'x' })).bug.id;
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    cookies: { todont_session: admin },
    payload: { status: 'nowhere' },
  });
  assert.equal(res.statusCode, 400);
});

test('a merged duplicate leaves the board and is counted on its parent', async () => {
  const parent = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'Parent' })).bug.id;
  const dup = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'Duplicate' })).bug.id;

  await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${dup}/merge`,
    cookies: { todont_session: admin },
    payload: { intoId: parent },
  });

  const board = body<{ bugs: Array<{ id: number; duplicateCount: number }> }>(
    await h.app.inject({ method: 'GET', url: '/api/bugs' }),
  ).bugs;

  assert.ok(!board.some((b) => b.id === dup), 'the duplicate is off the board');
  assert.equal(board.find((b) => b.id === parent)?.duplicateCount, 1);
});

test('a bug cannot be a duplicate of itself', async () => {
  const id = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'Alone' })).bug.id;
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/merge`,
    cookies: { todont_session: admin },
    payload: { intoId: id },
  });
  assert.equal(res.statusCode, 400);
});

test('blocking is manager-only, and loops are refused however long the chain', async () => {
  const a = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'A' })).bug.id;
  const b = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'B' })).bug.id;
  const c = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'C' })).bug.id;

  const asReporter = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${b}/blockers`,
    cookies: { todont_session: reporter },
    payload: { blockerId: a },
  });
  assert.equal(asReporter.statusCode, 403);

  const block = (blocked: number, blocker: number) =>
    h.app.inject({
      method: 'POST',
      url: `/api/bugs/${blocked}/blockers`,
      cookies: { todont_session: admin },
      payload: { blockerId: blocker },
    });

  assert.equal((await block(b, a)).statusCode, 201, 'b waits on a');
  assert.equal((await block(c, b)).statusCode, 201, 'c waits on b');

  // a waiting on c would close the loop a -> b -> c -> a
  assert.equal((await block(a, c)).statusCode, 409, 'the loop is refused');

  // and the direct case
  assert.equal((await block(a, b)).statusCode, 409);
});

test('both ends of a dependency are visible on the ticket', async () => {
  const parent = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'Waited on' })).bug.id;
  const child = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'Waiting' })).bug.id;

  await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${child}/blockers`,
    cookies: { todont_session: admin },
    payload: { blockerId: parent },
  });

  const blocked = body<{ bug: { blockedBy: Array<{ id: number }> } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${child}` }),
  ).bug;
  const blocker = body<{ bug: { blocking: Array<{ id: number }> } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${parent}` }),
  ).bug;

  assert.deepEqual(blocked.blockedBy.map((t) => t.id), [parent]);
  assert.deepEqual(blocker.blocking.map((t) => t.id), [child]);
});

test('externalRef makes a raise idempotent', async () => {
  const first = await raise(h.app, admin, { title: 'From a pipeline', externalRef: 'ci-123' });
  const again = await raise(h.app, admin, { title: 'Different title', externalRef: 'ci-123' });

  assert.equal(first.statusCode, 201);
  assert.equal(again.statusCode, 200);
  assert.equal(body<{ created: boolean }>(again).created, false);
  assert.equal(
    body<{ bug: { id: number } }>(first).bug.id,
    body<{ bug: { id: number } }>(again).bug.id,
  );
});

test('a level from the wrong scale is refused', async () => {
  const res = await raise(h.app, admin, { title: 'Mislevelled', severity: 'blocking' });
  assert.equal(res.statusCode, 400);

  const ok = await raise(h.app, admin, {
    title: 'Right scale',
    kind: 'feature',
    severity: 'blocking',
  });
  assert.equal(ok.statusCode, 201);
});

test('retyping a ticket carries its level across by position', async () => {
  const id = body<{ bug: { id: number } }>(
    await raise(h.app, admin, { title: 'Retype me', severity: 'critical' }),
  ).bug.id;

  const toFeature = await h.app.inject({
    method: 'PATCH',
    url: `/api/bugs/${id}`,
    cookies: { todont_session: admin },
    payload: { kind: 'feature' },
  });
  assert.equal(body<{ bug: { severity: string } }>(toFeature).bug.severity, 'blocking');

  const back = await h.app.inject({
    method: 'PATCH',
    url: `/api/bugs/${id}`,
    cookies: { todont_session: admin },
    payload: { kind: 'bug' },
  });
  assert.equal(body<{ bug: { severity: string } }>(back).bug.severity, 'critical');
});

test('a stack trace is stored normalised, and a repeat counts rather than duplicates', async () => {
  const B = String.fromCharCode(92);
  const trace =
    'System.NullReferenceException: Object reference not set to an instance of an object.' +
    `\n   at Mixer.SetGain(Single v) in C:${B}Users${B}ada${B}src${B}Mixer.cs:line 88`;

  const first = await raise(h.app, admin, { title: 'Crash', stackTrace: trace });
  assert.equal(first.statusCode, 201);
  const id = body<{ bug: { id: number } }>(first).bug.id;

  const stored = body<{ bug: { stackTrace: string } }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/bugs/${id}`,
      cookies: { todont_session: admin },
    }),
  ).bug.stackTrace;
  assert.ok(stored.includes('<HOME>'), 'the reporter is not named in it');

  // The same fault from another machine.
  const check = await h.app.inject({
    method: 'POST',
    url: '/api/stack-traces/check',
    payload: { stackTrace: trace.replace('ada', 'bob') },
  });
  assert.equal(body<{ raised: boolean }>(check).raised, true);
  assert.equal(body<{ occurrences: number }>(check).occurrences, 2);
});

test('a stack trace is readable by a manager and by nobody else', async () => {
  const seen = body<{ bug: { stackTrace: string; hasStackTrace: boolean } }>(
    await h.app.inject({
      method: 'GET',
      url: '/api/bugs',
      cookies: { todont_session: reporter },
    }),
  );
  assert.ok(seen); // the board itself never carries traces

  const withTrace = body<{ bugs: Array<{ id: number; title: string }> }>(
    await h.app.inject({ method: 'GET', url: '/api/bugs' }),
  ).bugs.find((b) => b.title === 'Crash')!;

  const anon = body<{ bug: { stackTrace: string; hasStackTrace: boolean } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${withTrace.id}` }),
  ).bug;
  assert.equal(anon.stackTrace, '', 'hidden from the public');
  assert.equal(anon.hasStackTrace, true, 'but its existence is not a secret');

  const asReporter = body<{ bug: { stackTrace: string } }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/bugs/${withTrace.id}`,
      cookies: { todont_session: reporter },
    }),
  ).bug;
  assert.equal(asReporter.stackTrace, '', 'hidden even from the reporter');

  const asAdmin = body<{ bug: { stackTrace: string } }>(
    await h.app.inject({
      method: 'GET',
      url: `/api/bugs/${withTrace.id}`,
      cookies: { todont_session: admin },
    }),
  ).bug;
  assert.ok(asAdmin.stackTrace.length > 0, 'readable by a manager');
});

test('a plain user cannot delete anything', async () => {
  const id = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'Safe' })).bug.id;
  const res = await h.app.inject({
    method: 'DELETE',
    url: `/api/bugs/${id}`,
    cookies: { todont_session: reporter },
  });
  assert.equal(res.statusCode, 403);
});

test('promotion changes what somebody may do', async () => {
  const cookie = await signUp(h.app, 'promoted@example.com', 'a good enough password', 'Promoted');
  const id = body<{ bug: { id: number } }>(await raise(h.app, admin, { title: 'For promotion' })).bug.id;

  const before = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    cookies: { todont_session: cookie },
    payload: { status: 'confirmed' },
  });
  assert.equal(before.statusCode, 403);

  const me = body<{ user: { id: number } }>(
    await h.app.inject({ method: 'GET', url: '/api/me', cookies: { todont_session: cookie } }),
  ).user;
  await setRole(h.app, admin, me.id, 'manager');

  const after = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    cookies: { todont_session: cookie },
    payload: { status: 'confirmed' },
  });
  assert.equal(after.statusCode, 200);
});
