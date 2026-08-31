import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { HttpError, requireScope } from '../auth/identity.js';
import { mailEnabled, resetMailer, sendMail } from '../lib/mailer.js';
import { readableSettings, writeSettings } from '../lib/settings.js';
import {
  boardSettings,
  invalidateColumns,
  listColumns,
  serializeColumnAdmin,
  setSetting,
  uniqueColumnKey,
  type ColumnRow,
} from '../lib/board.js';

const MAX_LABEL = 40;
const MAX_NAME = 60;
const MAX_TAGLINE = 120;

function requireColumn(id: number): ColumnRow {
  const row = listColumns().find((c) => c.id === id);
  if (!row) throw new HttpError(404, 'No such lane');
  return row;
}

function label(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, `${field} cannot be empty`);
  if (trimmed.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return trimmed;
}

/** #rrggbb, because it is written straight into a style attribute. */
function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
    throw new HttpError(400, 'color must be a hex value like #35c7e8');
  }
  return value.trim().toLowerCase();
}

export async function boardAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/columns', async (req) => {
    requireScope(req, 'admin');
    return { columns: listColumns().map(serializeColumnAdmin) };
  });

  /** A new lane goes on the end; reorder moves it. */
  app.post<{ Body: { label?: string; color?: string; terminal?: boolean } }>(
    '/api/admin/columns',
    async (req, reply) => {
      requireScope(req, 'admin');
      const body = req.body ?? {};

      const name = label(body.label, MAX_LABEL, 'Name');
      const hex = body.color === undefined ? '#6e8ca8' : color(body.color);
      const key = uniqueColumnKey(name);
      const last = listColumns().at(-1);

      const info = db
        .prepare(
          `INSERT INTO columns (key, label, color, position, is_intake, is_terminal)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .run(key, name, hex, (last?.position ?? 0) + 10, body.terminal ? 1 : 0);

      invalidateColumns();
      app.log.info({ key, label: name }, 'lane created');

      return reply.code(201).send({
        column: serializeColumnAdmin(requireColumn(Number(info.lastInsertRowid))),
      });
    },
  );

  /**
   * Rename, recolour, or change what a lane means. The key is deliberately not
   * editable: every ticket stores it, so changing it would orphan them all.
   */
  app.patch<{
    Params: { id: string };
    Body: { label?: string; color?: string; intake?: boolean; terminal?: boolean };
  }>('/api/admin/columns/:id', async (req) => {
    requireScope(req, 'admin');
    const column = requireColumn(Number(req.params.id));
    const body = req.body ?? {};

    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.label !== undefined) {
      sets.push('label = ?');
      params.push(label(body.label, MAX_LABEL, 'Name'));
    }
    if (body.color !== undefined) {
      sets.push('color = ?');
      params.push(color(body.color));
    }
    if (body.terminal !== undefined) {
      sets.push('is_terminal = ?');
      params.push(body.terminal ? 1 : 0);
    }

    const run = db.transaction(() => {
      // Exactly one intake lane: naming a new one stands the old one down,
      // rather than leaving new reports with two possible homes.
      if (body.intake === true) {
        db.prepare(`UPDATE columns SET is_intake = 0`).run();
        db.prepare(`UPDATE columns SET is_intake = 1 WHERE id = ?`).run(column.id);
      } else if (body.intake === false && column.is_intake === 1) {
        throw new HttpError(
          409,
          'Something has to receive new reports — make another lane the intake one instead',
        );
      }

      if (sets.length) {
        params.push(column.id);
        db.prepare(`UPDATE columns SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }
    });

    run();
    invalidateColumns();

    return { column: serializeColumnAdmin(requireColumn(column.id)) };
  });

  /** The whole order at once, so there is no half-applied state. */
  app.post<{ Body: { ids?: number[] } }>('/api/admin/columns/reorder', async (req) => {
    requireScope(req, 'admin');
    const ids = req.body?.ids;

    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ids is required');

    const known = listColumns();
    if (ids.length !== known.length || !known.every((c) => ids.includes(c.id))) {
      throw new HttpError(400, 'ids must list every lane exactly once');
    }

    const run = db.transaction(() => {
      const update = db.prepare(`UPDATE columns SET position = ? WHERE id = ?`);
      ids.forEach((id, i) => update.run((i + 1) * 10, id));
    });

    run();
    invalidateColumns();

    return { columns: listColumns().map(serializeColumnAdmin) };
  });

  /**
   * Remove a lane. Tickets are never silently dropped: a lane with any in it
   * must say where they go.
   */
  app.delete<{ Params: { id: string }; Querystring: { moveTo?: string } }>(
    '/api/admin/columns/:id',
    async (req) => {
      requireScope(req, 'admin');
      const column = requireColumn(Number(req.params.id));

      if (listColumns().length === 1) {
        throw new HttpError(409, 'A board needs at least one lane');
      }
      if (column.is_intake === 1) {
        throw new HttpError(
          409,
          'That lane receives new reports — make another one the intake lane first',
        );
      }

      const held = (
        db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status = ?`).get(column.key) as {
          n: number;
        }
      ).n;

      if (held > 0) {
        const moveTo = req.query.moveTo;
        const target = moveTo ? listColumns().find((c) => c.key === moveTo) : undefined;

        if (!target) {
          throw new HttpError(
            409,
            `${held} ticket(s) are in "${column.label}" — say which lane they should move to`,
          );
        }
        if (target.id === column.id) {
          throw new HttpError(400, 'Tickets cannot move to the lane being removed');
        }

        db.prepare(
          `UPDATE bugs SET status = ?, updated_at = datetime('now') WHERE status = ?`,
        ).run(target.key, column.key);

        app.log.info({ from: column.key, to: target.key, moved: held }, 'lane emptied before delete');
      }

      db.prepare(`DELETE FROM columns WHERE id = ?`).run(column.id);
      invalidateColumns();
      app.log.info({ key: column.key }, 'lane deleted');

      return { ok: true, deleted: column.key, moved: held };
    },
  );

  // ----------------------------------------------------------- board settings

  app.get('/api/admin/settings', async (req) => {
    requireScope(req, 'admin');
    return { settings: boardSettings() };
  });

  /**
   * Instance policy: how people get in, how long a session lasts, what may be
   * uploaded, and where mail goes. Everything here has an environment default
   * and a database override; the panel writes the override.
   */
  app.get('/api/admin/instance', async (req) => {
    requireScope(req, 'admin');
    return { settings: readableSettings() };
  });

  app.patch<{ Body: Record<string, unknown> }>('/api/admin/instance', async (req) => {
    const actor = requireScope(req, 'admin');

    // Which door this admin came through, so they cannot bolt it behind them.
    const actingProvider =
      actor.via === 'session'
        ? (db
            .prepare(`SELECT provider FROM identities WHERE user_id = ? LIMIT 1`)
            .get(actor.user.id) as { provider: string } | undefined)?.provider
        : undefined;

    writeSettings(req.body ?? {}, { actingProvider });
    resetMailer();

    return { settings: readableSettings() };
  });

  /**
   * Prove the mail settings work, to the person who just typed them, before
   * they find out from a user who never got a verification link.
   */
  app.post<{ Body: { to?: string } }>('/api/admin/instance/test-email', async (req) => {
    const actor = requireScope(req, 'admin');
    const to = (req.body?.to ?? actor.user.email ?? '').trim();

    if (!to) throw new HttpError(400, 'Give an address to send the test to');
    if (!mailEnabled()) {
      throw new HttpError(400, 'Set a mail server and a from address first');
    }

    const board = boardSettings().name;
    const sent = await sendMail(
      {
        to,
        subject: `${board}: test message`,
        text: [
          'This is a test from the administration panel.',
          '',
          'If you are reading it, this instance can send mail — verification and',
          'password reset links will reach people.',
        ].join('\n'),
      },
      app.log,
    );

    if (!sent) {
      throw new HttpError(
        502,
        'The mail server refused it. The container log has the reason.',
      );
    }

    return { ok: true, to };
  });

  app.patch<{ Body: { name?: string; tagline?: string } }>(
    '/api/admin/settings',
    async (req) => {
      requireScope(req, 'admin');
      const body = req.body ?? {};

      if (body.name !== undefined) setSetting('board.name', label(body.name, MAX_NAME, 'Board name'));
      if (body.tagline !== undefined) {
        // A tagline may legitimately be nothing at all.
        const trimmed = String(body.tagline).trim();
        if (trimmed.length > MAX_TAGLINE) {
          throw new HttpError(400, `Tagline is too long (max ${MAX_TAGLINE})`);
        }
        setSetting('board.tagline', trimmed);
      }

      return { settings: boardSettings() };
    },
  );
}
