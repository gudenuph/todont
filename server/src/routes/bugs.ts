import type { FastifyInstance } from 'fastify';
import { db, logEvent, type BugRow } from '../db.js';
import { INTAKE_COLUMN, isSeverity } from '../columns.js';
import { HttpError, requireScope, type Actor } from '../auth/identity.js';
import {
  listBugs,
  mergeBug,
  moveBug,
  requireBug,
  serializeDetail,
  unmergeBug,
} from '../lib/bugs.js';

const MAX_TITLE = 200;
const MAX_BODY = 20_000;

function text(value: unknown, max: number, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  }
  return trimmed;
}

function bugId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Bug id must be a positive integer');
  return id;
}

/**
 * Descriptive fields are editable by a manager, or by the reporter while the
 * bug is still untriaged — once someone has confirmed it, the text is part of
 * the record and only a manager should be rewriting it.
 */
function assertCanEdit(actor: Actor, bug: BugRow): void {
  if (actor.scopes.has('manage')) return;
  if (bug.reporter_id === actor.user.id && bug.status === INTAKE_COLUMN) return;
  throw new HttpError(403, 'Only a manager can edit this bug now');
}

export async function bugRoutes(app: FastifyInstance): Promise<void> {
  /** The board. Public — anyone can read, signed in or not. */
  app.get<{
    Querystring: { status?: string; q?: string; assignee?: string; includeMerged?: string };
  }>('/api/bugs', async (req) => {
    const assignee = req.query.assignee;
    return {
      bugs: listBugs({
        status: req.query.status,
        q: req.query.q,
        assigneeId: assignee !== undefined && assignee !== '' ? Number(assignee) : undefined,
        includeMerged: req.query.includeMerged === 'true',
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/bugs/:id', async (req) => {
    return { bug: serializeDetail(requireBug(bugId(req.params.id))) };
  });

  /**
   * Raise a bug. Used by the web form, by ezmuze itself, and by Claude — the
   * only difference is which credential arrives and what `source` records.
   */
  app.post<{
    Body: {
      title?: string;
      description?: string;
      steps?: string;
      expected?: string;
      actual?: string;
      severity?: string;
      appVersion?: string;
      environment?: string;
      externalRef?: string;
      status?: string;
    };
  }>('/api/bugs', async (req, reply) => {
    const actor = requireScope(req, 'write');
    const body = req.body ?? {};

    const title = text(body.title, MAX_TITLE, 'Title');
    if (!title) throw new HttpError(400, 'Title is required');

    const severity = body.severity ?? 'minor';
    if (!isSeverity(severity)) throw new HttpError(400, `Unknown severity "${severity}"`);

    const externalRef = text(body.externalRef, 200, 'externalRef') || null;
    if (externalRef) {
      const existing = db
        .prepare(`SELECT id FROM bugs WHERE external_ref = ?`)
        .get(externalRef) as { id: number } | undefined;
      // Idempotent raise: a caller retrying gets the bug it already created.
      if (existing) {
        return reply.code(200).send({ bug: serializeDetail(requireBug(existing.id)), created: false });
      }
    }

    // Everything lands in the intake column; only a manager may raise it
    // straight into a triaged one.
    let status = INTAKE_COLUMN;
    if (body.status && body.status !== INTAKE_COLUMN) {
      requireScope(req, 'manage');
      status = body.status;
    }

    const info = db
      .prepare(
        `INSERT INTO bugs
           (title, description, steps, expected, actual, severity,
            app_version, environment, status, position, reporter_id, source, external_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        title,
        text(body.description, MAX_BODY, 'Description'),
        text(body.steps, MAX_BODY, 'Steps to reproduce'),
        text(body.expected, MAX_BODY, 'Expected result'),
        text(body.actual, MAX_BODY, 'Actual result'),
        severity,
        text(body.appVersion, 100, 'App version'),
        text(body.environment, 500, 'Environment'),
        status,
        actor.user.id,
        actor.via === 'token' ? 'api' : 'web',
        externalRef,
      );

    const id = Number(info.lastInsertRowid);
    logEvent(id, actor.user.id, 'created', JSON.stringify({ via: actor.via }));
    moveBug(id, status, undefined, actor.user.id);

    return reply.code(201).send({ bug: serializeDetail(requireBug(id)), created: true });
  });

  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>('/api/bugs/:id', async (req) => {
    const actor = requireScope(req, 'write');
    const bug = requireBug(bugId(req.params.id));
    assertCanEdit(actor, bug);

    const body = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];

    const fields: Array<[string, string, number]> = [
      ['title', 'title', MAX_TITLE],
      ['description', 'description', MAX_BODY],
      ['steps', 'steps', MAX_BODY],
      ['expected', 'expected', MAX_BODY],
      ['actual', 'actual', MAX_BODY],
      ['appVersion', 'app_version', 100],
      ['environment', 'environment', 500],
    ];

    for (const [key, column, max] of fields) {
      if (body[key] === undefined) continue;
      const value = text(body[key], max, key);
      if (key === 'title' && !value) throw new HttpError(400, 'Title cannot be empty');
      sets.push(`${column} = ?`);
      params.push(value);
    }

    if (body.severity !== undefined) {
      if (!isSeverity(body.severity)) throw new HttpError(400, `Unknown severity "${body.severity}"`);
      sets.push('severity = ?');
      params.push(body.severity);
    }

    if (!sets.length) return { bug: serializeDetail(bug) };

    sets.push(`updated_at = datetime('now')`);
    params.push(bug.id);
    db.prepare(`UPDATE bugs SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    logEvent(bug.id, actor.user.id, 'edited', JSON.stringify({ fields: Object.keys(body) }));
    return { bug: serializeDetail(requireBug(bug.id)) };
  });

  /** Drag a card to another column, or reorder it within one. */
  app.post<{ Params: { id: string }; Body: { status?: string; index?: number } }>(
    '/api/bugs/:id/move',
    async (req) => {
      const actor = requireScope(req, 'manage');
      const { status, index } = req.body ?? {};
      if (!status) throw new HttpError(400, 'status is required');

      moveBug(bugId(req.params.id), status, index, actor.user.id);
      return { bug: serializeDetail(requireBug(bugId(req.params.id))) };
    },
  );

  /** Drop one card on another: mark this bug a duplicate of `intoId`. */
  app.post<{ Params: { id: string }; Body: { intoId?: number } }>(
    '/api/bugs/:id/merge',
    async (req) => {
      const actor = requireScope(req, 'manage');
      const intoId = Number(req.body?.intoId);
      if (!Number.isInteger(intoId)) throw new HttpError(400, 'intoId is required');

      const dup = mergeBug(bugId(req.params.id), intoId, actor.user.id);
      return {
        bug: serializeDetail(dup),
        into: serializeDetail(requireBug(dup.merged_into_id!)),
      };
    },
  );

  app.post<{ Params: { id: string } }>('/api/bugs/:id/unmerge', async (req) => {
    const actor = requireScope(req, 'manage');
    return { bug: serializeDetail(unmergeBug(bugId(req.params.id), actor.user.id)) };
  });

  /** Assign, unassign, or (for a manager) take a bug themselves. */
  app.post<{ Params: { id: string }; Body: { userId?: number | null } }>(
    '/api/bugs/:id/assign',
    async (req) => {
      const actor = requireScope(req, 'manage');
      const bug = requireBug(bugId(req.params.id));
      const raw = req.body?.userId;

      let assignee: number | null = null;
      if (raw !== null && raw !== undefined) {
        const target = db.prepare(`SELECT id FROM users WHERE id = ?`).get(Number(raw)) as
          | { id: number }
          | undefined;
        if (!target) throw new HttpError(404, 'No such user');
        assignee = target.id;
      }

      db.prepare(`UPDATE bugs SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        assignee,
        bug.id,
      );
      logEvent(bug.id, actor.user.id, assignee ? 'assigned' : 'unassigned', JSON.stringify({ assignee }));

      return { bug: serializeDetail(requireBug(bug.id)) };
    },
  );

  app.post<{ Params: { id: string }; Body: { body?: string } }>(
    '/api/bugs/:id/comments',
    async (req, reply) => {
      const actor = requireScope(req, 'write');
      const bug = requireBug(bugId(req.params.id));

      const body = text(req.body?.body, MAX_BODY, 'Comment');
      if (!body) throw new HttpError(400, 'A comment cannot be empty');

      db.prepare(`INSERT INTO comments (bug_id, author_id, body) VALUES (?, ?, ?)`).run(
        bug.id,
        actor.user.id,
        body,
      );
      db.prepare(`UPDATE bugs SET updated_at = datetime('now') WHERE id = ?`).run(bug.id);

      return reply.code(201).send({ bug: serializeDetail(requireBug(bug.id)) });
    },
  );
}
