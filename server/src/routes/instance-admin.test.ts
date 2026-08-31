import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, signUp, body, type Harness } from '../test/harness.js';

let h: Harness;
let admin: string;
let plain: string;

before(async () => {
  h = await makeApp({ AUTH_PROVIDERS: 'local,ezmuze' });
  admin = await signUp(h.app, 'boss@example.com', 'a good enough password', 'Boss');
  plain = await signUp(h.app, 'plain@example.com', 'a good enough password', 'Plain');
});
after(async () => h.close());

const get = () =>
  h.app.inject({ method: 'GET', url: '/api/admin/instance', cookies: { todont_session: admin } });

const patch = (payload: Record<string, unknown>, cookie = admin) =>
  h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    cookies: { todont_session: cookie },
    payload,
  });

test('only an admin may read or change instance settings', async () => {
  assert.equal(
    (
      await h.app.inject({
        method: 'GET',
        url: '/api/admin/instance',
        cookies: { todont_session: plain },
      })
    ).statusCode,
    403,
  );
  assert.equal((await patch({ 'auth.allowSignup': false }, plain)).statusCode, 403);
});

test('settings start from the environment and are overridden by the database', async () => {
  const before = body<{ settings: Record<string, unknown> }>(await get()).settings;
  assert.equal(before['auth.allowSignup'], true, 'from ALLOW_SIGNUP');

  await patch({ 'auth.allowSignup': false });

  const after = body<{ settings: Record<string, unknown> }>(await get()).settings;
  assert.equal(after['auth.allowSignup'], false);
});

test('a policy change takes effect immediately, with no restart', async () => {
  const refused = await h.app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'late@example.com', password: 'a good enough password' },
  });
  assert.equal(refused.statusCode, 403, 'signup is closed now');

  await patch({ 'auth.allowSignup': true });

  const allowed = await h.app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'late@example.com', password: 'a good enough password' },
  });
  assert.equal(allowed.statusCode, 201);
});

test('an admin cannot switch off the way they signed in', async () => {
  const res = await patch({ 'auth.providers': ['ezmuze'] });
  assert.equal(res.statusCode, 409);
  assert.match(body<{ error: string }>(res).error, /lock you out/i);
});

test('nor switch every way off', async () => {
  assert.equal((await patch({ 'auth.providers': [] })).statusCode, 400);
  assert.equal((await patch({ 'auth.providers': ['nonsense'] })).statusCode, 400);
});

test('but may switch off one they did not use', async () => {
  const res = await patch({ 'auth.providers': ['local'] });
  assert.equal(res.statusCode, 200);

  const options = body<{ providers: string[] }>(
    await h.app.inject({ method: 'GET', url: '/api/auth/providers' }),
  );
  assert.deepEqual(options.providers, ['local']);
});

test('an upload limit cannot be raised past what the server was started with', async () => {
  const ceiling = Number(body<{ settings: Record<string, unknown> }>(await get()).settings['uploads.maxBytesCeiling']);

  assert.equal((await patch({ 'uploads.maxBytes': ceiling + 1 })).statusCode, 400);
  assert.equal((await patch({ 'uploads.maxBytes': Math.floor(ceiling / 2) })).statusCode, 200);
});

test('numbers have to be numbers', async () => {
  assert.equal((await patch({ 'session.days': 0 })).statusCode, 400);
  assert.equal((await patch({ 'session.days': 'soon' })).statusCode, 400);
  assert.equal((await patch({ 'session.days': 14 })).statusCode, 200);
});

test('an unknown setting is refused rather than quietly stored', async () => {
  assert.equal((await patch({ 'something.invented': 'x' })).statusCode, 400);
});

test('a saved password is never handed back', async () => {
  await patch({ 'smtp.pass': 'hunter2hunter2' });

  const settings = body<{ settings: Record<string, unknown> }>(await get()).settings;
  assert.equal(settings['smtp.pass'], true, 'only whether it is set');
  assert.ok(!JSON.stringify(settings).includes('hunter2'), 'and never the value');
});

test('an empty password means "leave it alone", not "clear it"', async () => {
  await patch({ 'smtp.pass': '' });
  assert.equal(body<{ settings: Record<string, unknown> }>(await get()).settings['smtp.pass'], true);

  await patch({ 'smtp.pass': null });
  assert.equal(body<{ settings: Record<string, unknown> }>(await get()).settings['smtp.pass'], false);
});

test('a test email needs somewhere to send from', async () => {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/admin/instance/test-email',
    cookies: { todont_session: admin },
    payload: { to: 'someone@example.com' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(body<{ error: string }>(res).error, /mail server/i);
});
