import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import Database from 'better-sqlite3';
import { makeApp, signUp, type Harness } from '../test/harness.js';

/**
 * What a backup archive gives away.
 *
 * A session can carry an ezmuze AuthKey — a live credential for that person's
 * account on another service — so what matters is that a copy of the database
 * does not hand it over. The environment file holding COOKIE_SECRET is
 * deliberately not in an archive, which is what makes that possible.
 */

const exec = promisify(execFile);

let h: Harness;
let dbPath: string;

before(async () => {
  h = await makeApp();
  await signUp(h.app, 'boss@example.com');
  dbPath = path.join(h.dir, 'tracker.db');
});
after(async () => h.close());

test('an AuthKey is not readable in the database it is stored in', async () => {
  const { createSession } = await import('./identity.js');
  const { open } = await import('../lib/secretbox.js');

  const secret = 'AUTHKEY-c0ffee-not-a-real-one';
  const sid = createSession(1, secret);

  // Exactly what somebody unpacking an archive would see.
  const { db } = await import('../db.js');
  const stored = (
    db.prepare(`SELECT auth_key FROM sessions WHERE id = ?`).get(sid) as { auth_key: string }
  ).auth_key;

  assert.ok(!stored.includes(secret), 'the key is in the clear');
  assert.ok(!stored.includes('AUTHKEY'), 'the key is in the clear');
  assert.match(stored, /^v1:/);

  // and the running server can still use it
  assert.equal(open(stored), secret);
});

test('a session with no AuthKey stores nothing rather than sealing an empty string', async () => {
  const { createSession } = await import('./identity.js');
  const { db } = await import('../db.js');

  const sid = createSession(1, null);
  const row = db.prepare(`SELECT auth_key FROM sessions WHERE id = ?`).get(sid) as {
    auth_key: string | null;
  };

  assert.equal(row.auth_key, null);
});

test('keys stored before encryption are sealed the next time the server boots', async () => {
  const { db } = await import('../db.js');
  const { open } = await import('../lib/secretbox.js');

  // A row exactly as an older build would have written it.
  db.prepare(
    `INSERT INTO sessions (id, user_id, auth_key, expires_at)
     VALUES ('legacy-session', 1, 'AUTHKEY-plaintext-from-before', datetime('now', '+7 days'))`,
  ).run();

  // Close this process's handle, then boot the server once against the same
  // directory — which is what a deploy does, and where the migration runs.
  await h.app.close();
  const { closeDb } = await import('../db.js');
  closeDb();

  // A file:// URL, not a path: Windows absolute paths are not a valid ESM
  // specifier, and `C:` reads as an unsupported protocol.
  const entry = new URL('../db.js', import.meta.url).href;
  await exec(process.execPath, ['-e', `import(${JSON.stringify(entry)}).then(() => process.exit(0))`], {
    env: {
      ...process.env,
      DATA_DIR: h.dir,
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
    },
  });

  // Read it the way an archive would be read: no app, just the file.
  const copy = new Database(dbPath, { readonly: true });
  const row = copy.prepare(`SELECT auth_key FROM sessions WHERE id = 'legacy-session'`).get() as {
    auth_key: string;
  };
  copy.close();

  assert.match(row.auth_key, /^v1:/, 'the old plaintext key was left as it was');
  assert.ok(!row.auth_key.includes('AUTHKEY-plaintext-from-before'));
  assert.equal(open(row.auth_key), 'AUTHKEY-plaintext-from-before', 'and it still works');
});
