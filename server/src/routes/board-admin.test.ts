import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, signUp, body, type Harness } from '../test/harness.js';

let h: Harness;
let admin: string;
let plain: string;

before(async () => {
  h = await makeApp();
  admin = await signUp(h.app, 'boss@example.com', 'a good enough password', 'Boss');
  plain = await signUp(h.app, 'plain@example.com', 'a good enough password', 'Plain');
});
after(async () => h.close());

const asAdmin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  h.app.inject({ method, url, cookies: { todont_session: admin }, payload: payload as never });

test('only an admin may reshape the board', async () => {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/columns',
    cookies: { todont_session: plain },
    payload: { label: 'Sneaky' },
  });
  assert.equal(res.statusCode, 403);
});

test('a fresh instance has lanes, exactly one of which takes new reports', async () => {
  const lanes = body<{ columns: Array<{ intake: boolean }> }>(
    await asAdmin('GET', '/api/admin/columns'),
  ).columns;

  assert.ok(lanes.length >= 2);
  assert.equal(lanes.filter((l) => l.intake).length, 1);
});

test('renaming a lane leaves its key, so no ticket moves', async () => {
  const before = body<{ columns: Array<{ id: number; key: string }> }>(
    await asAdmin('GET', '/api/admin/columns'),
  ).columns[1];

  const after = body<{ column: { key: string; label: string } }>(
    await asAdmin('PATCH', `/api/admin/columns/${before.id}`, { label: 'Triaged' }),
  ).column;

  assert.equal(after.label, 'Triaged');
  assert.equal(after.key, before.key, 'the key is permanent');
});

test('naming a new intake lane stands the old one down', async () => {
  const lanes = body<{ columns: Array<{ id: number; intake: boolean }> }>(
    await asAdmin('GET', '/api/admin/columns'),
  ).columns;
  const notIntake = lanes.find((l) => !l.intake)!;

  await asAdmin('PATCH', `/api/admin/columns/${notIntake.id}`, { intake: true });

  const after = body<{ columns: Array<{ id: number; intake: boolean }> }>(
    await asAdmin('GET', '/api/admin/columns'),
  ).columns;
  assert.equal(after.filter((l) => l.intake).length, 1);
  assert.ok(after.find((l) => l.id === notIntake.id)?.intake);

  // put it back
  await asAdmin('PATCH', `/api/admin/columns/${lanes[0].id}`, { intake: true });
});

test('the last intake lane cannot be stood down, and cannot be removed', async () => {
  const intake = body<{ columns: Array<{ id: number; intake: boolean }> }>(
    await asAdmin('GET', '/api/admin/columns'),
  ).columns.find((l) => l.intake)!;

  assert.equal(
    (await asAdmin('PATCH', `/api/admin/columns/${intake.id}`, { intake: false })).statusCode,
    409,
  );
  assert.equal((await asAdmin('DELETE', `/api/admin/columns/${intake.id}`)).statusCode, 409);
});

test('a lane holding tickets will not vanish without somewhere for them to go', async () => {
  const lanes = body<{ columns: Array<{ id: number; key: string; intake: boolean }> }>(
    await asAdmin('GET', '/api/admin/columns'),
  ).columns;
  const target = lanes.find((l) => !l.intake)!;
  const other = lanes.find((l) => !l.intake && l.id !== target.id)!;

  const id = body<{ bug: { id: number } }>(
    await asAdmin('POST', '/api/bugs', { title: 'In a doomed lane' }),
  ).bug.id;
  await asAdmin('POST', `/api/bugs/${id}/move`, { status: target.key });

  assert.equal((await asAdmin('DELETE', `/api/admin/columns/${target.id}`)).statusCode, 409);

  const moved = await asAdmin('DELETE', `/api/admin/columns/${target.id}?moveTo=${other.key}`);
  assert.equal(moved.statusCode, 200);
  assert.equal(body<{ moved: number }>(moved).moved, 1);

  const bug = body<{ bug: { status: string } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${id}` }),
  ).bug;
  assert.equal(bug.status, other.key, 'the ticket went where we said');
});

test('a partial reorder is refused rather than half-applied', async () => {
  const ids = body<{ columns: Array<{ id: number }> }>(
    await asAdmin('GET', '/api/admin/columns'),
  ).columns.map((c) => c.id);

  assert.equal((await asAdmin('POST', '/api/admin/columns/reorder', { ids: ids.slice(1) })).statusCode, 400);

  const reversed = [...ids].reverse();
  const ok = await asAdmin('POST', '/api/admin/columns/reorder', { ids: reversed });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(
    body<{ columns: Array<{ id: number }> }>(ok).columns.map((c) => c.id),
    reversed,
  );
});

test('the board name is a setting, and reaches the public meta', async () => {
  await asAdmin('PATCH', '/api/admin/settings', { name: 'Acme Tracker', tagline: 'on fire' });

  const meta = body<{ board: { name: string; tagline: string } }>(
    await h.app.inject({ method: 'GET', url: '/api/meta' }),
  );
  assert.equal(meta.board.name, 'Acme Tracker');
  assert.equal(meta.board.tagline, 'on fire');
});

test('a type holding tickets will not vanish without somewhere for them to go', async () => {
  const kinds = body<{ kinds: Array<{ id: number; key: string }> }>(
    await asAdmin('GET', '/api/admin/kinds'),
  ).kinds;
  const feature = kinds.find((k) => k.key === 'feature')!;

  await asAdmin('POST', '/api/bugs', { title: 'A request', kind: 'feature', severity: 'want' });

  assert.equal((await asAdmin('DELETE', `/api/admin/kinds/${feature.id}`)).statusCode, 409);

  const moved = await asAdmin('DELETE', `/api/admin/kinds/${feature.id}?moveTo=bug`);
  assert.equal(moved.statusCode, 200);

  // "want" is third on the request scale, so it becomes the third bug level.
  const bugs = body<{ bugs: Array<{ title: string; kind: string; severity: string }> }>(
    await h.app.inject({ method: 'GET', url: '/api/bugs' }),
  ).bugs;
  const moved0 = bugs.find((b) => b.title === 'A request')!;
  assert.equal(moved0.kind, 'bug');
  assert.equal(moved0.severity, 'minor', 'carried across by position');
});

test('the last type cannot be removed', async () => {
  const kinds = body<{ kinds: Array<{ id: number }> }>(
    await asAdmin('GET', '/api/admin/kinds'),
  ).kinds;
  assert.equal(kinds.length, 1, 'the previous test left one');
  assert.equal((await asAdmin('DELETE', `/api/admin/kinds/${kinds[0].id}`)).statusCode, 409);
});
