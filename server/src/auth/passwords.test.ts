import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, normalizeEmail, passwordProblem, verifyPassword } from './passwords.js';

test('a password verifies against its own hash and nothing else', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', hash));
  assert.ok(!(await verifyPassword('Correct horse battery', hash)), 'case matters');
  assert.ok(!(await verifyPassword('', hash)));
});

test('the same password hashes differently every time', async () => {
  assert.notEqual(await hashPassword('same input'), await hashPassword('same input'));
});

test('the hash carries its own parameters, so they can be raised later', async () => {
  const [scheme, n, r, p] = (await hashPassword('anything')).split('$');
  assert.equal(scheme, 'scrypt');
  assert.ok(Number(n) >= 16384, 'work factor');
  assert.equal(r, '8');
  assert.equal(p, '1');
});

test('a corrupted hash fails the login rather than throwing', async () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5', 'scrypt$a$b$c$d$e']) {
    assert.equal(await verifyPassword('anything', bad), false, JSON.stringify(bad));
  }
});

test('passwords have a length rule and nothing more annoying', () => {
  assert.ok(passwordProblem('short'));
  assert.equal(passwordProblem('just long enough'), null);
  assert.ok(passwordProblem('x'.repeat(500)));
  assert.ok(passwordProblem(12345 as unknown as string));
});

test('emails are lowercased and trimmed, and obvious rubbish is refused', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('no@domain'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(undefined), null);
});
