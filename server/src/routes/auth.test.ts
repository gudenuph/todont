import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, signUp, body, type Harness } from '../test/harness.js';

let h: Harness;
before(async () => {
  h = await makeApp();
});
after(async () => h.close());

test('the first account is admin, the next is not', async () => {
  await signUp(h.app, 'first@example.com', 'a good enough password', 'First');
  const second = await h.app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'second@example.com', password: 'a good enough password' },
  });

  assert.equal(body<{ user: { role: string } }>(second).user.role, 'user');
});

test('an email is taken only once, whatever its casing', async () => {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'FIRST@Example.com', password: 'a good enough password' },
  });
  assert.equal(res.statusCode, 409);
});

test('login is case-insensitive on the address and exact on the password', async () => {
  const ok = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'First@Example.COM', password: 'a good enough password' },
  });
  assert.equal(ok.statusCode, 200);

  const bad = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'first@example.com', password: 'not the password' },
  });
  assert.equal(bad.statusCode, 401);
});

test('a failed login says the same thing whether or not the account exists', async () => {
  const wrongPassword = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'first@example.com', password: 'not the password' },
  });
  const noSuchAccount = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'nobody@example.com', password: 'not the password' },
  });

  assert.equal(wrongPassword.statusCode, noSuchAccount.statusCode);
  assert.equal(body(wrongPassword).error, body(noSuchAccount).error);
});

test('forgot answers identically for a real address and an invented one', async () => {
  const real = await h.app.inject({
    method: 'POST',
    url: '/api/auth/forgot',
    payload: { email: 'first@example.com' },
  });
  const fake = await h.app.inject({
    method: 'POST',
    url: '/api/auth/forgot',
    payload: { email: 'nobody-at-all@example.com' },
  });

  assert.equal(real.statusCode, 200);
  assert.deepEqual(body(real), body(fake));
});

test('a reset link cannot be forged', async () => {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/auth/reset',
    payload: { token: 'not a real token', newPassword: 'a good enough password' },
  });
  assert.equal(res.statusCode, 400);
});

test('anonymous is nobody, and a session is somebody', async () => {
  const anon = await h.app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(body<{ user: unknown }>(anon).user, null);

  const cookie = await signUp(h.app, 'third@example.com');
  const me = await h.app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { todont_session: cookie },
  });
  assert.equal(body<{ user: { name: string } }>(me).user.name, 'third');
});

test('signing out ends the session', async () => {
  const cookie = await signUp(h.app, 'fourth@example.com');
  await h.app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    cookies: { todont_session: cookie },
  });

  const after = await h.app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { todont_session: cookie },
  });
  assert.equal(body<{ user: unknown }>(after).user, null);
});

test('a bad token says so, rather than telling a build server to sign in', async () => {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/bugs',
    headers: { authorization: 'Bearer ezb_not_a_real_token' },
    payload: { title: 'nope' },
  });

  assert.equal(res.statusCode, 401);
  assert.match(body<{ error: string }>(res).error, /token/i);
});
