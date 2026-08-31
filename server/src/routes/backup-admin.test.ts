import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeApp, signUp, body, type Harness } from '../test/harness.js';

/**
 * Backups are the one feature where a green test is not enough on its own:
 * what matters is that the bytes come back. So this takes a real archive,
 * unpacks it, and reads the tickets out of the database inside it.
 */

let h: Harness;
let admin: string;
let plain: string;

before(async () => {
  h = await makeApp();
  admin = await signUp(h.app, 'boss@example.com');
  plain = await signUp(h.app, 'plain@example.com');
});
after(async () => h.close());

const as = (cookie: string) => ({ cookies: { todont_session: cookie } });

test('only an admin can see or run backups', async () => {
  for (const [method, url] of [
    ['GET', '/api/admin/backups'],
    ['POST', '/api/admin/backups/run'],
  ] as const) {
    assert.equal((await h.app.inject({ method, url, ...as(plain) })).statusCode, 403);
    assert.equal((await h.app.inject({ method, url })).statusCode, 401);
  }
});

test('a backup is taken, kept on disk, and holds the real data', async () => {
  const raised = await h.app.inject({
    method: 'POST',
    url: '/api/bugs',
    ...as(admin),
    payload: { title: 'Survives the apocalypse', description: 'A ticket worth keeping.' },
  });
  assert.equal(raised.statusCode, 201);

  const run = await h.app.inject({
    method: 'POST',
    url: '/api/admin/backups/run',
    ...as(admin),
  });
  assert.equal(run.statusCode, 200, run.body);

  const { report } = body<{ report: { ok: boolean; file: string; bytes: number } }>(run);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.bytes > 0);

  // It is listed, and it is downloadable.
  const listed = body<{ archives: Array<{ name: string }> }>(
    await h.app.inject({ method: 'GET', url: '/api/admin/backups', ...as(admin) }),
  );
  assert.ok(listed.archives.some((a) => a.name === report.file));

  const download = await h.app.inject({
    method: 'GET',
    url: `/api/admin/backups/${report.file}`,
    ...as(admin),
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['content-type'], 'application/gzip');
  assert.equal(download.rawPayload.length, report.bytes);

  // The part that actually matters: unpack it and read the ticket back out.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const restore = path.join(h.dir, 'restore');
  await fs.mkdir(restore, { recursive: true });
  // Relative name, run from inside the directory: an absolute Windows path
  // starts `C:`, which GNU tar reads as a remote host.
  await fs.copyFile(path.join(h.dir, 'backups', report.file), path.join(restore, report.file));
  await exec('tar', ['-xzf', report.file], { cwd: restore });

  const { default: Database } = await import('better-sqlite3');
  const restored = new Database(path.join(restore, 'tracker.db'), { readonly: true });
  const row = restored.prepare(`SELECT title FROM bugs ORDER BY id DESC LIMIT 1`).get() as {
    title: string;
  };
  restored.close();

  assert.equal(row.title, 'Survives the apocalypse');
});

test('old archives are pruned down to the number to keep, oldest first', async () => {
  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'backup.keep': 2 },
  });

  // Backdated, and deliberately of both shapes: a full archive and a
  // database-only one do not sort against each other by name, so age has to
  // come from the file rather than from the string.
  const dir = path.join(h.dir, 'backups');
  // Start from a known folder — an earlier test has already left one here.
  for (const stale of await fs.readdir(dir)) await fs.rm(path.join(dir, stale));
  const aged = [
    ['full-2020-01-01T00-00-00.tar.gz', new Date('2020-01-01')],
    ['database-2021-01-01T00-00-00.tar.gz', new Date('2021-01-01')],
    ['full-2022-01-01T00-00-00.tar.gz', new Date('2022-01-01')],
  ] as const;

  for (const [name, at] of aged) {
    await fs.writeFile(path.join(dir, name), 'not really an archive');
    await fs.utimes(path.join(dir, name), at, at);
  }

  const run = await h.app.inject({ method: 'POST', url: '/api/admin/backups/run', ...as(admin) });
  const { report } = body<{ report: { file: string } }>(run);

  const { archives } = body<{ archives: Array<{ name: string }> }>(
    await h.app.inject({ method: 'GET', url: '/api/admin/backups', ...as(admin) }),
  );

  assert.equal(archives.length, 2);
  assert.equal(archives[0].name, report.file, 'the newest one is the one just taken');
  assert.equal(archives[1].name, 'full-2022-01-01T00-00-00.tar.gz', 'then the next newest');
});

test('a backup can be deleted, and nothing outside the folder can be', async () => {
  const { archives } = body<{ archives: Array<{ name: string }> }>(
    await h.app.inject({ method: 'GET', url: '/api/admin/backups', ...as(admin) }),
  );
  const victim = archives[0].name;

  assert.equal(
    (
      await h.app.inject({
        method: 'DELETE',
        url: `/api/admin/backups/${victim}`,
        ...as(admin),
      })
    ).statusCode,
    200,
  );

  const after = body<{ archives: Array<{ name: string }> }>(
    await h.app.inject({ method: 'GET', url: '/api/admin/backups', ...as(admin) }),
  );
  assert.ok(!after.archives.some((a) => a.name === victim));

  // The name comes off a URL. Anything that is not an archive name is refused
  // outright; anything that tries to climb out of the folder is flattened to
  // its last segment, so it can only ever name something inside it.
  for (const attempt of ['..%2F..%2Ftracker.db', 'tracker.db', 'uploads']) {
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/admin/backups/${attempt}`,
      ...as(admin),
    });
    assert.equal(res.statusCode, 400, `${attempt} should not be accepted`);
  }

  await h.app.inject({
    method: 'DELETE',
    url: '/api/admin/backups/..%2F..%2Fsomething.tar.gz',
    ...as(admin),
  });

  // Whatever those did, they did not reach the database.
  await fs.access(path.join(h.dir, 'tracker.db'));
});

test('a destination that fails is reported without stopping the rest', async () => {
  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'backup.emailTo': 'nobody@example.com' },
  });

  const run = await h.app.inject({ method: 'POST', url: '/api/admin/backups/run', ...as(admin) });

  // No mail server is configured here, so email fails — but the disk copy is
  // still made, and the run still reports rather than throwing.
  assert.equal(run.statusCode, 200, run.body);
  const { report } = body<{
    report: { ok: boolean; delivered: string[]; failed: Array<{ where: string }> };
  }>(run);

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.failed.map((f) => f.where),
    ['email'],
  );
  assert.ok(report.delivered.some((d) => d.includes('disk')));

  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'backup.emailTo': '' },
  });
});

test('running a command is refused unless the server allows it', async () => {
  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'backup.command': 'echo "would have run"' },
  });

  const { report } = body<{ report: { failed: Array<{ where: string; why: string }> } }>(
    await h.app.inject({ method: 'POST', url: '/api/admin/backups/run', ...as(admin) }),
  );

  const failure = report.failed.find((f) => f.where === 'command');
  assert.ok(failure, 'the command should not have run');
  assert.match(failure.why, /BACKUP_ALLOW_COMMAND/);

  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'backup.command': '' },
  });
});

test('the schedule follows the frequency, and off means off', async () => {
  const { nextRunAt } = await import('../lib/backup.js');
  const set = (patch: Record<string, unknown>) =>
    h.app.inject({ method: 'PATCH', url: '/api/admin/instance', ...as(admin), payload: patch });

  await set({ 'backup.frequency': 'off' });
  assert.equal(nextRunAt(), null);

  const noon = new Date('2026-03-04T12:00:00');

  await set({ 'backup.frequency': 'daily', 'backup.hour': 3 });
  const daily = nextRunAt(noon)!;
  assert.equal(daily.getHours(), 3);
  assert.equal(daily.getDate(), 5, 'three in the morning has passed, so it is tomorrow');

  await set({ 'backup.frequency': 'hourly' });
  const hourly = nextRunAt(noon)!;
  assert.equal(hourly.getHours(), 12);
  assert.equal(hourly.getMinutes(), 17);

  await set({ 'backup.frequency': 'weekly', 'backup.hour': 3 });
  const weekly = nextRunAt(noon)!;
  assert.equal(weekly.getDay(), 0, 'weekly runs on a Sunday');
  assert.ok(weekly.getTime() > noon.getTime());

  await set({ 'backup.frequency': 'off' });
});

test('changing the schedule is reflected without a restart', async () => {
  const before = body<{ nextRunAt: string | null }>(
    await h.app.inject({ method: 'GET', url: '/api/admin/backups', ...as(admin) }),
  );
  assert.equal(before.nextRunAt, null);

  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'backup.frequency': 'daily' },
  });

  const after = body<{ nextRunAt: string | null }>(
    await h.app.inject({ method: 'GET', url: '/api/admin/backups', ...as(admin) }),
  );
  assert.ok(after.nextRunAt, 'a run is scheduled now');

  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/instance',
    ...as(admin),
    payload: { 'backup.frequency': 'off' },
  });
});
