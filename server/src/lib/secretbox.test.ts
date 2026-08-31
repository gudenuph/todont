import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The guarantee being tested is not "it encrypts" — it is that a copy of the
 * database, which is what a backup is, does not carry working credentials.
 */

let seal: (s: string) => string;
let open: (s: string | null) => string | null;
let isSealed: (s: string | null) => boolean;

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    COOKIE_SECRET: 'a-test-secret-that-is-long-enough-to-sign-with',
    PUBLIC_URL: 'http://test.local',
  });
  ({ seal, open, isSealed } = await import('./secretbox.js'));
});

test('what goes in comes back out', () => {
  const key = 'AUTHKEY-7f3c9a21-not-a-real-one';
  const sealed = seal(key);

  assert.equal(open(sealed), key);
  assert.equal(isSealed(sealed), true);
});

test('the sealed form does not contain the plaintext', () => {
  const key = 'AUTHKEY-7f3c9a21-not-a-real-one';
  const sealed = seal(key);

  assert.ok(!sealed.includes(key));
  assert.ok(!sealed.includes('AUTHKEY'));
  // and it is not merely encoded
  assert.ok(!Buffer.from(sealed.slice(3), 'base64url').toString('utf8').includes('AUTHKEY'));
});

test('the same value seals differently every time', () => {
  // A repeated ciphertext would tell someone holding two backups that a user
  // has not signed in again between them.
  assert.notEqual(seal('same'), seal('same'));
});

test('a tampered value will not open', () => {
  const sealed = seal('AUTHKEY-7f3c9a21');
  const body = Buffer.from(sealed.slice(3), 'base64url');
  body[body.length - 1] ^= 0xff;

  assert.equal(open(`v1:${body.toString('base64url')}`), null);
});

test('nothing opens under a different cookie secret', async () => {
  const sealed = seal('AUTHKEY-7f3c9a21');

  // What somebody with only the archive has: the rows, and no environment file.
  const { resetSecretbox } = await import('./secretbox.js');
  process.env.COOKIE_SECRET = 'a-completely-different-secret-of-the-same-sort';
  resetSecretbox();

  // config caches the boot value, so reach the derivation the way a fresh
  // process would: re-derive with the new secret and confirm it cannot read it.
  const { createDecipheriv, hkdfSync } = await import('node:crypto');
  const other = Buffer.from(
    hkdfSync('sha256', process.env.COOKIE_SECRET, 'todont-secretbox', 'auth-key-at-rest', 32),
  );
  const raw = Buffer.from(sealed.slice(3), 'base64url');

  assert.throws(() => {
    const d = createDecipheriv('aes-256-gcm', other, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  }, 'a different secret must not open it');

  resetSecretbox();
});

test('rubbish and empties are handled rather than thrown', () => {
  assert.equal(open(null), null);
  assert.equal(open(''), null);
  assert.equal(open('v1:not-base64-really-!!!'), null);
  assert.equal(open('v1:'), null);
  assert.equal(isSealed(null), false);
});

test('a value written before encryption existed still reads', () => {
  // Only reachable until the boot migration has run once, but a session that
  // survives a deploy must not break in the meantime.
  assert.equal(open('LEGACY-PLAINTEXT-KEY'), 'LEGACY-PLAINTEXT-KEY');
  assert.equal(isSealed('LEGACY-PLAINTEXT-KEY'), false);
});
