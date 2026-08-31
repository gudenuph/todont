import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { HttpError, requireScope } from '../auth/identity.js';
import {
  HIDEABLE_FIELDS,
  LABEL_SLOTS,
  invalidateCatalog,
  listEnvironments,
  listKinds,
  serializeKindAdmin,
  uniqueKindKey,
  uniqueLevelKey,
} from '../lib/catalog.js';

const MAX_LABEL = 60;
const MAX_WORDING = 120;

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, `${field} cannot be empty`);
  if (trimmed.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return trimmed;
}

function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
    throw new HttpError(400, 'color must be a hex value like #35c7e8');
  }
  return value.trim().toLowerCase();
}

function kindRow(id: number): { id: number; key: string } {
  const row = db.prepare(`SELECT id, key FROM kinds WHERE id = ?`).get(id) as
    | { id: number; key: string }
    | undefined;
  if (!row) throw new HttpError(404, 'No such type');
  return row;
}

export async function catalogAdminRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ environments

  app.get('/api/admin/environments', async (req) => {
    requireScope(req, 'admin');
    const rows = db
      .prepare(`SELECT * FROM environments ORDER BY position, id`)
      .all() as Array<{ id: number; label: string; position: number }>;
    return { environments: rows };
  });

  app.post<{ Body: { label?: string } }>('/api/admin/environments', async (req, reply) => {
    requireScope(req, 'admin');
    const label = text(req.body?.label, MAX_LABEL, 'Name');

    if (listEnvironments().includes(label)) {
      throw new HttpError(409, 'That one is already on the list');
    }

    const last = db.prepare(`SELECT MAX(position) AS p FROM environments`).get() as { p: number | null };
    db.prepare(`INSERT INTO environments (label, position) VALUES (?, ?)`).run(
      label,
      (last.p ?? 0) + 10,
    );
    invalidateCatalog();

    return reply.code(201).send({ environments: listEnvironments() });
  });

  /**
   * Remove one. Tickets keep the environment as plain text, so this only takes
   * it off the picker — nothing already reported changes.
   */
  app.delete<{ Params: { id: string } }>('/api/admin/environments/:id', async (req) => {
    requireScope(req, 'admin');
    const info = db.prepare(`DELETE FROM environments WHERE id = ?`).run(Number(req.params.id));
    if (!info.changes) throw new HttpError(404, 'No such environment');
    invalidateCatalog();
    return { ok: true, environments: listEnvironments() };
  });

  app.post<{ Body: { ids?: number[] } }>('/api/admin/environments/reorder', async (req) => {
    requireScope(req, 'admin');
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ids is required');

    const run = db.transaction(() => {
      const update = db.prepare(`UPDATE environments SET position = ? WHERE id = ?`);
      ids.forEach((id, i) => update.run((i + 1) * 10, id));
    });
    run();
    invalidateCatalog();

    return { environments: listEnvironments() };
  });

  // -------------------------------------------------------------------- kinds

  app.get('/api/admin/kinds', async (req) => {
    requireScope(req, 'admin');
    return {
      kinds: listKinds().map((k) => serializeKindAdmin(k.key)),
      hideableFields: HIDEABLE_FIELDS,
      labelSlots: LABEL_SLOTS,
    };
  });

  /** A new type starts with a copy of the first one's scale, so it is usable. */
  app.post<{ Body: { label?: string; emoji?: string } }>('/api/admin/kinds', async (req, reply) => {
    requireScope(req, 'admin');
    const label = text(req.body?.label, MAX_LABEL, 'Name');
    const emoji = (req.body?.emoji ?? '📌').trim().slice(0, 8) || '📌';
    const key = uniqueKindKey(label);
    const last = db.prepare(`SELECT MAX(position) AS p FROM kinds`).get() as { p: number | null };

    const create = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO kinds (key, label, emoji, article, hidden_fields, labels, position)
           VALUES (?, ?, ?, ?, '[]', '{}', ?)`,
        )
        .run(key, label, emoji, `a ${label.toLowerCase()}`, (last.p ?? 0) + 10);

      const kindId = Number(info.lastInsertRowid);
      const template = listKinds()[0];
      const insert = db.prepare(
        `INSERT INTO levels (kind_id, key, label, short, color, position) VALUES (?, ?, ?, ?, ?, ?)`,
      );

      // A type with no scale cannot have a ticket raised against it, so give it
      // the existing one to edit rather than an empty list to discover.
      (template?.levels ?? [{ key: 'normal', label: 'Normal', short: 'Normal', color: '#6e8ca8' }]).forEach(
        (l, i) => insert.run(kindId, l.key, l.label, l.short, l.color, (i + 1) * 10),
      );
      return kindId;
    });

    const id = create();
    invalidateCatalog();
    app.log.info({ key, label }, 'ticket type created');

    return reply.code(201).send({ kind: serializeKindAdmin(kindRow(id).key) });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      label?: string;
      emoji?: string;
      article?: string;
      hiddenFields?: string[];
      labels?: Record<string, string>;
    };
  }>('/api/admin/kinds/:id', async (req) => {
    requireScope(req, 'admin');
    const row = kindRow(Number(req.params.id));
    const body = req.body ?? {};

    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.label !== undefined) {
      sets.push('label = ?');
      params.push(text(body.label, MAX_LABEL, 'Name'));
    }
    if (body.emoji !== undefined) {
      sets.push('emoji = ?');
      params.push(text(body.emoji, 8, 'Emoji'));
    }
    if (body.article !== undefined) {
      sets.push('article = ?');
      params.push(text(body.article, MAX_LABEL, 'Wording'));
    }
    if (body.hiddenFields !== undefined) {
      if (!Array.isArray(body.hiddenFields)) throw new HttpError(400, 'hiddenFields must be a list');
      const unknown = body.hiddenFields.filter(
        (f) => !(HIDEABLE_FIELDS as readonly string[]).includes(f),
      );
      if (unknown.length) throw new HttpError(400, `Not a field that can be hidden: ${unknown[0]}`);
      sets.push('hidden_fields = ?');
      params.push(JSON.stringify(body.hiddenFields));
    }
    if (body.labels !== undefined) {
      const labels: Record<string, string> = {};
      for (const slot of LABEL_SLOTS) {
        const value = body.labels[slot];
        if (typeof value === 'string' && value.trim()) {
          labels[slot] = value.trim().slice(0, MAX_WORDING);
        }
      }
      sets.push('labels = ?');
      params.push(JSON.stringify(labels));
    }

    if (sets.length) {
      params.push(row.id);
      db.prepare(`UPDATE kinds SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      invalidateCatalog();
    }

    return { kind: serializeKindAdmin(row.key) };
  });

  app.post<{ Body: { ids?: number[] } }>('/api/admin/kinds/reorder', async (req) => {
    requireScope(req, 'admin');
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length !== listKinds().length) {
      throw new HttpError(400, 'ids must list every type exactly once');
    }

    const run = db.transaction(() => {
      const update = db.prepare(`UPDATE kinds SET position = ? WHERE id = ?`);
      ids.forEach((id, i) => update.run((i + 1) * 10, id));
    });
    run();
    invalidateCatalog();

    return { kinds: listKinds().map((k) => serializeKindAdmin(k.key)) };
  });

  app.delete<{ Params: { id: string }; Querystring: { moveTo?: string } }>(
    '/api/admin/kinds/:id',
    async (req) => {
      requireScope(req, 'admin');
      const row = kindRow(Number(req.params.id));

      if (listKinds().length === 1) throw new HttpError(409, 'A board needs at least one type');

      const held = (
        db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE kind = ?`).get(row.key) as { n: number }
      ).n;

      if (held > 0) {
        const target = listKinds().find((k) => k.key === req.query.moveTo && k.key !== row.key);
        if (!target) {
          throw new HttpError(
            409,
            `${held} ticket(s) are of that type — say which type they should become`,
          );
        }
        // Levels do not survive the move, so carry each ticket across by
        // position the same way retyping one at a time would.
        const { translateLevel } = await import('../lib/catalog.js');
        const move = db.transaction(() => {
          const tickets = db
            .prepare(`SELECT id, severity FROM bugs WHERE kind = ?`)
            .all(row.key) as Array<{ id: number; severity: string }>;
          const update = db.prepare(`UPDATE bugs SET kind = ?, severity = ? WHERE id = ?`);
          for (const t of tickets) {
            update.run(target.key, translateLevel(row.key, target.key, t.severity), t.id);
          }
        });
        move();
      }

      db.prepare(`DELETE FROM kinds WHERE id = ?`).run(row.id);
      invalidateCatalog();
      app.log.info({ key: row.key, moved: held }, 'ticket type deleted');

      return { ok: true, deleted: row.key, moved: held };
    },
  );

  // ------------------------------------------------------------------- levels

  app.post<{ Params: { id: string }; Body: { label?: string; short?: string; color?: string } }>(
    '/api/admin/kinds/:id/levels',
    async (req, reply) => {
      requireScope(req, 'admin');
      const row = kindRow(Number(req.params.id));
      const label = text(req.body?.label, MAX_LABEL, 'Name');
      const short = req.body?.short ? text(req.body.short, 20, 'Short name') : label.slice(0, 20);
      const hex = req.body?.color === undefined ? '#6e8ca8' : color(req.body.color);

      const last = db.prepare(`SELECT MAX(position) AS p FROM levels WHERE kind_id = ?`).get(row.id) as {
        p: number | null;
      };

      db.prepare(
        `INSERT INTO levels (kind_id, key, label, short, color, position) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.id, uniqueLevelKey(row.id, label), label, short, hex, (last.p ?? 0) + 10);

      invalidateCatalog();
      return reply.code(201).send({ kind: serializeKindAdmin(row.key) });
    },
  );

  app.patch<{
    Params: { id: string; levelKey: string };
    Body: { label?: string; short?: string; color?: string };
  }>('/api/admin/kinds/:id/levels/:levelKey', async (req) => {
    requireScope(req, 'admin');
    const row = kindRow(Number(req.params.id));
    const body = req.body ?? {};

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.label !== undefined) {
      sets.push('label = ?');
      params.push(text(body.label, MAX_LABEL, 'Name'));
    }
    if (body.short !== undefined) {
      sets.push('short = ?');
      params.push(text(body.short, 20, 'Short name'));
    }
    if (body.color !== undefined) {
      sets.push('color = ?');
      params.push(color(body.color));
    }

    if (sets.length) {
      params.push(row.id, req.params.levelKey);
      const info = db
        .prepare(`UPDATE levels SET ${sets.join(', ')} WHERE kind_id = ? AND key = ?`)
        .run(...params);
      if (!info.changes) throw new HttpError(404, 'No such level');
      invalidateCatalog();
    }

    return { kind: serializeKindAdmin(row.key) };
  });

  app.post<{ Params: { id: string }; Body: { keys?: string[] } }>(
    '/api/admin/kinds/:id/levels/reorder',
    async (req) => {
      requireScope(req, 'admin');
      const row = kindRow(Number(req.params.id));
      const keys = req.body?.keys;
      if (!Array.isArray(keys) || !keys.length) throw new HttpError(400, 'keys is required');

      const run = db.transaction(() => {
        const update = db.prepare(`UPDATE levels SET position = ? WHERE kind_id = ? AND key = ?`);
        keys.forEach((key, i) => update.run((i + 1) * 10, row.id, key));
      });
      run();
      invalidateCatalog();

      return { kind: serializeKindAdmin(row.key) };
    },
  );

  app.delete<{ Params: { id: string; levelKey: string }; Querystring: { moveTo?: string } }>(
    '/api/admin/kinds/:id/levels/:levelKey',
    async (req) => {
      requireScope(req, 'admin');
      const row = kindRow(Number(req.params.id));

      const levels = db
        .prepare(`SELECT key FROM levels WHERE kind_id = ? ORDER BY position, id`)
        .all(row.id) as Array<{ key: string }>;
      if (levels.length <= 1) throw new HttpError(409, 'A type needs at least one level');

      const held = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM bugs WHERE kind = ? AND severity = ?`)
          .get(row.key, req.params.levelKey) as { n: number }
      ).n;

      if (held > 0) {
        const target = req.query.moveTo;
        if (!target || target === req.params.levelKey || !levels.some((l) => l.key === target)) {
          throw new HttpError(
            409,
            `${held} ticket(s) are at that level — say which one they should become`,
          );
        }
        db.prepare(`UPDATE bugs SET severity = ? WHERE kind = ? AND severity = ?`).run(
          target,
          row.key,
          req.params.levelKey,
        );
      }

      const info = db
        .prepare(`DELETE FROM levels WHERE kind_id = ? AND key = ?`)
        .run(row.id, req.params.levelKey);
      if (!info.changes) throw new HttpError(404, 'No such level');

      invalidateCatalog();
      return { kind: serializeKindAdmin(row.key), moved: held };
    },
  );
}
