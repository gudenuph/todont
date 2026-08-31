import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError, requireScope } from '../auth/identity.js';
import { lastRun, listLocalBackups, nextRunAt, runBackup, scheduleBackups } from '../lib/backup.js';

export async function backupAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/backups', async (req) => {
    requireScope(req, 'admin');
    const next = nextRunAt();
    return {
      lastRun: lastRun(),
      nextRunAt: next ? next.toISOString() : null,
      archives: await listLocalBackups(),
      commandAllowed: config.backupAllowCommand,
    };
  });

  /**
   * Run one now. Used to prove a destination works before trusting it with a
   * schedule — the same reason the mail settings have a test button.
   */
  app.post('/api/admin/backups/run', async (req) => {
    requireScope(req, 'admin');
    const report = await runBackup(app.log);

    // A backup that reached nowhere is a failure worth an error, not a green tick.
    if (!report.ok && report.delivered.length === 0) {
      throw new HttpError(502, report.failed.map((f) => `${f.where}: ${f.why}`).join('; '));
    }
    return { report };
  });

  /** Re-arm the schedule after the settings change. */
  app.post('/api/admin/backups/reschedule', async (req) => {
    requireScope(req, 'admin');
    scheduleBackups(app.log);
    const next = nextRunAt();
    return { nextRunAt: next ? next.toISOString() : null };
  });

  /** Download one, because a backup you cannot fetch is not much of a backup. */
  app.get<{ Params: { name: string } }>('/api/admin/backups/:name', async (req, reply) => {
    requireScope(req, 'admin');

    // The name comes from a URL, so it must not be able to point outside.
    const name = path.basename(req.params.name);
    if (!/^[\w.-]+\.tar\.gz$/.test(name)) throw new HttpError(400, 'Not a backup file name');

    const file = path.join(config.dataDir, 'backups', name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'No such backup');

    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(fs.createReadStream(file));
  });

  app.delete<{ Params: { name: string } }>('/api/admin/backups/:name', async (req) => {
    requireScope(req, 'admin');
    const name = path.basename(req.params.name);
    if (!/^[\w.-]+\.tar\.gz$/.test(name)) throw new HttpError(400, 'Not a backup file name');

    await fs.promises.rm(path.join(config.dataDir, 'backups', name), { force: true });
    return { ok: true };
  });
}
