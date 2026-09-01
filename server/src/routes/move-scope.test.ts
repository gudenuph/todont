import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, signUp, body, type Harness } from '../test/harness.js';

/**
 * The `move` scope.
 *
 * A release pipeline walks tickets along as it publishes them. Before this it
 * had to be given `manage` to do that, which also let it delete bugs, delete
 * comments and merge tickets — far too much authority for a credential sitting
 * in a file on a build runner.
 */

let h: Harness;
let admin: string;

/** Mint a token acting as a bot, and hand back the secret. */
async function mint(
  scopes: string[],
  name = scopes.join('-'),
  botRole: 'user' | 'manager' = 'manager',
): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/tokens',
    cookies: { todont_session: admin },
    payload: { name, scopes, botName: name, botRole },
  });
  if (res.statusCode >= 400) throw new Error(`mint failed: ${res.body}`);
  return body<{ token: string }>(res).token;
}

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function raise(title: string): Promise<number> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/bugs',
    cookies: { todont_session: admin },
    payload: { title },
  });
  return body<{ bug: { id: number } }>(res).bug.id;
}

const statusOf = async (id: number) =>
  body<{ bug: { status: string } }>(await h.app.inject({ method: 'GET', url: `/api/bugs/${id}` }))
    .bug.status;

before(async () => {
  h = await makeApp();
  admin = await signUp(h.app, 'boss@example.com');
});
after(async () => h.close());

test('a publishing token without move cannot move a ticket', async () => {
  // Exactly what the README used to tell you to mint.
  const token = await mint(['read', 'versions'], 'old-publishing');
  const id = await raise('Queued for release');

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    ...as(token),
    payload: { status: 'backlog' },
  });

  assert.equal(res.statusCode, 403);
  // and the message says what to do about it, rather than "only managers can"
  assert.match(body<{ error: string }>(res).error, /"move" scope/);
  assert.equal(await statusOf(id), 'unconfirmed');
});

test('a pipeline token with move walks a ticket along and says why', async () => {
  const token = await mint(['read', 'versions', 'move', 'write'], 'publishing');
  const id = await raise('About to go to beta');

  const moved = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    ...as(token),
    payload: { status: 'in-beta-testing' },
  });

  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(await statusOf(id), 'in-beta-testing');

  // The pipeline comments after each move; that is `write`, and it works.
  const said = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/comments`,
    ...as(token),
    payload: { body: 'went out to beta in 2026.9.0' },
  });
  assert.equal(said.statusCode, 201, said.body);
});

test('move does not smuggle in the rest of manage', async () => {
  const token = await mint(['read', 'versions', 'move', 'write'], 'narrow');
  const keep = await raise('Must survive');
  const other = await raise('Also here');

  // The three things a leaked pipeline credential must not be able to do.
  const refusals = await Promise.all([
    h.app.inject({ method: 'DELETE', url: `/api/bugs/${keep}`, ...as(token) }),
    h.app.inject({
      method: 'POST',
      url: `/api/bugs/${other}/merge`,
      ...as(token),
      payload: { intoId: keep },
    }),
    h.app.inject({
      method: 'POST',
      url: `/api/bugs/${keep}/assign`,
      ...as(token),
      payload: { userId: 1 },
    }),
  ]);

  for (const res of refusals) assert.equal(res.statusCode, 403, res.body);

  // Still there, still on its own.
  assert.equal(await statusOf(keep), 'unconfirmed');
  assert.equal(await statusOf(other), 'unconfirmed');
});

test('a token minted before move existed still moves', async () => {
  // `manage` is the larger power and always included moving; tokens already in
  // use must not stop working the day the narrower scope arrives.
  const token = await mint(['read', 'write', 'manage'], 'legacy-manager');
  const id = await raise('Moved by an old token');

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    ...as(token),
    payload: { status: 'confirmed' },
  });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await statusOf(id), 'confirmed');
});

test('a plain person still cannot move anything', async () => {
  const plain = await signUp(h.app, 'plain@example.com');
  const id = await raise('Not yours to move');

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    cookies: { todont_session: plain },
    payload: { status: 'backlog' },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(await statusOf(id), 'unconfirmed');
});

test('move cannot be granted beyond what the account behind it may do', async () => {
  // The ceiling still holds: asking for `move` on a token that acts as an
  // ordinary user gets you a token that cannot move, not a promotion.
  const token = await mint(['read', 'write', 'move'], 'user-level', 'user');
  const id = await raise('Still not movable');

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/bugs/${id}/move`,
    ...as(token),
    payload: { status: 'backlog' },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(await statusOf(id), 'unconfirmed');
});
