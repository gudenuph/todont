import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

/**
 * The schema in db.ts is written for a fresh database and the migrations
 * below it for an old one, and the two are easy to get out of step: a column
 * added to CREATE TABLE plus an index in the same block passes every test
 * (they all start empty) and refuses to start on the real database, where
 * CREATE TABLE IF NOT EXISTS skips the table and the index runs against a
 * column that the migration has not added yet. That is exactly what took the
 * live board down on 2026-09-06 (parent_id).
 *
 * So this test builds a database the way an OLD build would have, then boots
 * db.ts against it in a child process (the module migrates at import time and
 * is already loaded in this one) and expects it to come up with the new
 * columns in place.
 */
test('an old database migrates on import instead of refusing to start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'todont-upgrade-'));
  const here = dirname(fileURLToPath(import.meta.url));
  // A file URL, not a path: on Windows an absolute path is read as a "c:"
  // scheme by the ESM loader and refused.
  const boot = join(dir, 'boot.mjs');
  writeFileSync(boot, `import(${JSON.stringify(pathToFileURL(join(here, 'db.js')).href)}).then(() => process.exit(0));`);
  const bootOnce = () =>
    spawnSync(process.execPath, [boot], { env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'test' }, encoding: 'utf8' });

  // 1. A fresh database, shaped by today's schema block.
  const fresh = bootOnce();
  assert.equal(fresh.status, 0, `db.ts refused an empty directory:\n${fresh.stderr}`);

  // 2. Wind it back to what an old install has: every column that arrived
  //    through addColumnIfMissing is removed again, along with its index
  //    (SQLite will not drop an indexed column). Add a migrated column to
  //    db.ts and it belongs in this list.
  const migrated = ['kind', 'stack_trace', 'stack_fingerprint', 'occurrences', 'parent_id'];
  const db = new Database(join(dir, 'tracker.db'));
  db.exec(`DROP INDEX IF EXISTS idx_bugs_fingerprint; DROP INDEX IF EXISTS idx_bugs_parent;`);
  for (const col of migrated) db.exec(`ALTER TABLE bugs DROP COLUMN ${col}`);
  db.prepare(`INSERT INTO bugs (title) VALUES (?)`).run('from before');
  db.close();

  // 3. Boot again: the schema block must tolerate the old table, and the
  //    migrations must put every column back.
  const upgraded = bootOnce();
  assert.equal(upgraded.status, 0, `db.ts refused an old database:\n${upgraded.stderr}`);

  const after = new Database(join(dir, 'tracker.db'), { readonly: true });
  const cols = (after.prepare(`PRAGMA table_info(bugs)`).all() as Array<{ name: string }>).map((c) => c.name);
  const kept = after.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE title = 'from before'`).get() as { n: number };
  after.close();
  for (const col of migrated) assert.ok(cols.includes(col), `${col} was not added back to an old bugs table`);
  assert.equal(kept.n, 1, 'the old row did not survive the upgrade');
});
