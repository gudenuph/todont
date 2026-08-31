import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { getSetting, setSetting, boardSettings } from './board.js';
import { settingBool, settingInt, settingText } from './settings.js';
import { putObject } from './s3.js';
import { mailEnabled, sendMail } from './mailer.js';

const run = promisify(execFile);

const exists = (at: string) => fs.access(at).then(() => true).catch(() => false);

/**
 * Backups, scheduled and delivered by the tracker itself.
 *
 * Doing this inside the app rather than in host cron is what lets it be
 * configured from the admin panel — an operator who can only reach a web page
 * can still arrange for their data to survive the machine.
 *
 * Two sizes, and the difference matters: the database is the tickets, the
 * comments, the accounts and the history, and it is tiny. The attachments are
 * everything else and are usually a hundred times bigger. A database-only
 * backup fits in an email; a full one does not.
 */

export type Frequency = 'off' | 'hourly' | 'daily' | 'weekly';

export interface BackupReport {
  at: string;
  ok: boolean;
  bytes: number;
  file: string;
  includedUploads: boolean;
  delivered: string[];
  failed: Array<{ where: string; why: string }>;
}

const LOCAL_DIR = () => path.join(config.dataDir, 'backups');

/** A consistent copy of a database that is being written to. */
async function snapshotDatabase(into: string): Promise<void> {
  // VACUUM INTO writes a clean copy without stopping the server. Copying the
  // file directly would risk catching it mid-write, and a torn SQLite file
  // restores to nothing at all.
  await fs.rm(into, { force: true });
  // Bound, not interpolated: a Windows path is full of backslashes, and SQLite
  // string literals do not process escapes, so pasting one in corrupts it.
  db.prepare('VACUUM INTO ?').run(into);
}

/**
 * Build the archive and hand back its bytes.
 *
 * tar and gzip are in the image; nothing else is, which is why delivery is
 * built on those two plus plain HTTPS rather than on rsync or rclone.
 */
export async function createArchive(includeUploads: boolean): Promise<{
  name: string;
  body: Buffer;
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const work = await fs.mkdtemp(path.join(config.dataDir, '.backup-'));

  try {
    await snapshotDatabase(path.join(work, 'tracker.db'));

    const entries = ['tracker.db'];
    const hasUploads = includeUploads && (await exists(config.uploadDir));
    if (hasUploads) {
      await fs.symlink(config.uploadDir, path.join(work, 'uploads')).catch(async () => {
        // Symlinks can be refused; fall back to copying.
        await fs.cp(config.uploadDir, path.join(work, 'uploads'), { recursive: true });
      });
      entries.push('uploads');
    }

    const name = `${includeUploads ? 'full' : 'database'}-${stamp}.tar.gz`;

    // Relative names, run from inside the work directory. An absolute Windows
    // path starts `C:` and GNU tar reads that as a remote host, so it tries to
    // rsh somewhere rather than write a file.
    await run('tar', ['-czhf', name, ...entries], { cwd: work });
    const body = await fs.readFile(path.join(work, name));

    return { name, body };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- delivery

async function keepOnDisk(name: string, body: Buffer, keep: number): Promise<string> {
  const dir = LOCAL_DIR();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body, { mode: 0o600 });

  // Oldest first, by modification time rather than by name: the name carries a
  // prefix as well as a timestamp, so a database-only archive and a full one
  // do not sort against each other chronologically.
  const existing = await listLocalBackups();
  for (const old of existing.slice(keep)) {
    await fs.rm(path.join(dir, old.name), { force: true });
  }

  return `kept on disk (${Math.min(existing.length, keep)} retained)`;
}

async function emailIt(
  name: string,
  body: Buffer,
  to: string,
  log: Parameters<typeof sendMail>[1],
): Promise<string> {
  if (!mailEnabled()) throw new Error('no mail server is configured');

  // Most mailboxes refuse anything much over 25MB, and bounce silently.
  const limit = 20 * 1024 * 1024;
  if (body.length > limit) {
    throw new Error(
      `${Math.round(body.length / 1024 / 1024)}MB is too large to email — ` +
        'turn off "include attachments", or send it somewhere else',
    );
  }

  const board = boardSettings().name;
  const sent = await sendMail(
    {
      to,
      subject: `${board}: backup ${name}`,
      text: [
        `Attached is a backup of ${board}, taken ${new Date().toUTCString()}.`,
        '',
        'Restore by extracting it over the instance data directory.',
      ].join('\n'),
      attachments: [{ filename: name, content: body }],
    },
    log,
  );

  if (!sent) throw new Error('the mail server refused it');
  return `emailed to ${to}`;
}

async function toObjectStorage(name: string, body: Buffer): Promise<string> {
  const target = {
    endpoint: settingText('backup.s3.endpoint'),
    region: settingText('backup.s3.region') || 'auto',
    bucket: settingText('backup.s3.bucket'),
    accessKeyId: settingText('backup.s3.accessKeyId'),
    secretAccessKey: settingText('backup.s3.secretAccessKey'),
    prefix: settingText('backup.s3.prefix'),
  };

  for (const [field, value] of Object.entries(target)) {
    if (!value && field !== 'prefix') throw new Error(`object storage needs ${field}`);
  }

  await putObject(target, name, body, 'application/gzip');
  return `uploaded to ${target.bucket}`;
}

/**
 * Hand the archive to a command of the operator's choosing.
 *
 * The escape hatch for rsync, git, scp and rclone — which is how anything
 * reaches Google Drive or Dropbox. Off unless the operator turns it on in the
 * environment: an admin account is not otherwise a shell account, and this
 * would quietly make it one.
 */
async function toCommand(archivePath: string): Promise<string> {
  if (!config.backupAllowCommand) {
    throw new Error(
      'running a command is disabled — set BACKUP_ALLOW_COMMAND=true on the server to allow it',
    );
  }

  const command = settingText('backup.command');
  if (!command) throw new Error('no command is configured');

  await run('/bin/sh', ['-c', command], {
    timeout: 10 * 60 * 1000,
    env: { ...process.env, BACKUP_FILE: archivePath },
  });

  return 'handed to the configured command';
}

// ----------------------------------------------------------------- running

export async function runBackup(
  log: Parameters<typeof sendMail>[1],
): Promise<BackupReport> {
  const includeUploads = settingBool('backup.includeUploads');
  const { name, body } = await createArchive(includeUploads);

  const delivered: string[] = [];
  const failed: BackupReport['failed'] = [];

  // Disk first and always: whatever else is configured, there is a copy here
  // the moment this finishes, and the command hook needs a file to point at.
  let onDisk = '';
  try {
    const note = await keepOnDisk(name, body, settingInt('backup.keep'));
    onDisk = path.join(LOCAL_DIR(), name);
    delivered.push(note);
  } catch (err) {
    failed.push({ where: 'disk', why: err instanceof Error ? err.message : String(err) });
  }

  const destinations: Array<[string, () => Promise<string>]> = [];
  if (settingText('backup.emailTo')) {
    destinations.push(['email', () => emailIt(name, body, settingText('backup.emailTo'), log)]);
  }
  if (settingText('backup.s3.bucket')) {
    destinations.push(['object storage', () => toObjectStorage(name, body)]);
  }
  if (settingText('backup.command')) {
    destinations.push(['command', () => toCommand(onDisk)]);
  }

  // One failing destination must not stop the others; a backup that reached
  // two of three places is worth far more than none.
  for (const [where, deliver] of destinations) {
    try {
      delivered.push(await deliver());
    } catch (err) {
      failed.push({ where, why: err instanceof Error ? err.message : String(err) });
    }
  }

  const report: BackupReport = {
    at: new Date().toISOString(),
    ok: failed.length === 0,
    bytes: body.length,
    file: name,
    includedUploads: includeUploads,
    delivered,
    failed,
  };

  setSetting('backup.lastRun', JSON.stringify(report));
  log.info({ report }, report.ok ? 'backup complete' : 'backup finished with failures');

  return report;
}

export function lastRun(): BackupReport | null {
  const raw = getSetting('backup.lastRun', '');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackupReport;
  } catch {
    return null;
  }
}

/** What is on this machine, newest first. */
export async function listLocalBackups(): Promise<Array<{ name: string; bytes: number }>> {
  try {
    const dir = LOCAL_DIR();
    const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.tar.gz'));

    const found = await Promise.all(
      names.map(async (name) => {
        const stat = await fs.stat(path.join(dir, name));
        return { name, bytes: stat.size, at: stat.mtimeMs };
      }),
    );

    return found.sort((a, b) => b.at - a.at).map(({ name, bytes }) => ({ name, bytes }));
  } catch {
    return [];
  }
}

// --------------------------------------------------------------- scheduling

let timer: NodeJS.Timeout | null = null;

/** When the next run is due, given the configured frequency and hour. */
export function nextRunAt(from = new Date()): Date | null {
  const frequency = settingText('backup.frequency') as Frequency;
  if (frequency === 'off') return null;

  const hour = settingInt('backup.hour');
  const next = new Date(from);

  if (frequency === 'hourly') {
    next.setMinutes(17, 0, 0); // not on the hour, when everything else runs
    if (next <= from) next.setHours(next.getHours() + 1);
    return next;
  }

  next.setHours(hour, 17, 0, 0);
  if (frequency === 'weekly') {
    // Sunday, so a week's worth is never mid-week work.
    const days = (7 - next.getDay()) % 7;
    next.setDate(next.getDate() + days);
  }
  if (next <= from) next.setDate(next.getDate() + (frequency === 'weekly' ? 7 : 1));

  return next;
}

/**
 * (Re)arm the schedule. Called at boot and whenever the settings change, so a
 * change in the panel takes effect without a restart.
 */
export function scheduleBackups(log: Parameters<typeof sendMail>[1]): void {
  if (timer) clearTimeout(timer);
  timer = null;

  const next = nextRunAt();
  if (!next) return;

  const delay = Math.max(1000, next.getTime() - Date.now());
  timer = setTimeout(() => {
    void runBackup(log)
      .catch((err: unknown) => log.warn({ err }, 'scheduled backup failed'))
      .finally(() => scheduleBackups(log));
  }, delay);

  // Never hold the process open for a backup.
  timer.unref();
  log.info({ next: next.toISOString() }, 'next backup scheduled');
}

export function stopBackups(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
