import type { FastifyInstance } from 'fastify';
import { db, logEvent, type BugRow } from '../db.js';
import {
  defaultKind,
  defaultLevelFor,
  isKind,
  isLevelOf,
  levelsFor,
  translateLevel,
} from '../lib/catalog.js';
import { intakeColumn } from '../lib/board.js';
import {
  HttpError,
  canSeeStackTrace,
  requireActor,
  requireScope,
  type Actor,
} from '../auth/identity.js';
import {
  deleteBug,
  listBugs,
  mergeBug,
  moveBug,
  requireBug,
  serializeDetail,
  unmergeBug,
} from '../lib/bugs.js';
import { fingerprintStackTrace, normalizeStackTrace } from '../lib/stacktrace.js';
import { addBlocker, removeBlocker } from '../lib/blocks.js';
import { findByFingerprint, recordOccurrence } from './stacktraces.js';

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_TRACE = 20_000;

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
  if (bug.reporter_id === actor.user.id && bug.status === intakeColumn()) return;
  throw new HttpError(403, 'Only a manager can edit this bug now');
}

export async function bugRoutes(app: FastifyInstance): Promise<void> {
  /** The board. Public — anyone can read, signed in or not. */
  app.get<{
    Querystring: {
      status?: string;
      kind?: string;
      q?: string;
      assignee?: string;
      mine?: string;
      includeMerged?: string;
    };
  }>('/api/bugs', async (req) => {
    const assignee = req.query.assignee;

    // "Only my bugs" needs to know who is asking, so it is the one filter that
    // requires a signed-in caller.
    const mine = req.query.mine === 'true' ? requireActor(req).user.id : undefined;

    return {
      bugs: listBugs({
        status: req.query.status,
        kind: req.query.kind,
        q: req.query.q,
        assigneeId: assignee !== undefined && assignee !== '' ? Number(assignee) : undefined,
        mineUserId: mine,
        includeMerged: req.query.includeMerged === 'true',
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/bugs/:id', async (req) => {
    return { bug: serializeDetail(requireBug(bugId(req.params.id)), canSeeStackTrace(req)) };
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
      kind?: string;
      stackTrace?: string;
    };
  }>('/api/bugs', async (req, reply) => {
    const actor = requireScope(req, 'write');
    const body = req.body ?? {};

    const title = text(body.title, MAX_TITLE, 'Title');
    if (!title) throw new HttpError(400, 'Title is required');

    const kind = body.kind ?? defaultKind();
    if (!isKind(kind)) throw new HttpError(400, `Unknown kind "${kind}"`);

    const severity = body.severity ?? defaultLevelFor(kind);
    if (!isLevelOf(kind, severity)) {
      throw new HttpError(
        400,
        `"${severity}" is not a level for a ${kind} — expected one of ` +
          levelsFor(kind)
            .map((l) => l.key)
            .join(', '),
      );
    }

    const externalRef = text(body.externalRef, 200, 'externalRef') || null;
    if (externalRef) {
      const existing = db
        .prepare(`SELECT id FROM bugs WHERE external_ref = ?`)
        .get(externalRef) as { id: number } | undefined;
      // Idempotent raise: a caller retrying gets the bug it already created.
      if (existing) {
        return reply.code(200).send({ bug: serializeDetail(requireBug(existing.id), canSeeStackTrace(req)), created: false });
      }
    }

    // A trace is stored already normalised, so no username or machine path
    // reaches a board that anybody can read.
    const rawTrace = text(body.stackTrace, MAX_TRACE, 'Stack trace');
    const stackTrace = rawTrace ? normalizeStackTrace(rawTrace) : '';
    const fingerprint = rawTrace ? fingerprintStackTrace(rawTrace) : null;

    // Same crash, already on the board: count the sighting and hand back what
    // is already there. This is what makes the flow safe for a client that
    // skips /api/stack-traces/check and just reports every crash.
    if (fingerprint) {
      const known = findByFingerprint(fingerprint);
      if (known) {
        const updated = recordOccurrence(known, actor.user.id);
        return reply.code(200).send({
          bug: serializeDetail(updated, canSeeStackTrace(req)),
          created: false,
          alreadyRaised: true,
          occurrences: updated.occurrences,
        });
      }
    }

    // Everything lands in the intake column; only a manager may raise it
    // straight into a triaged one.
    let status = intakeColumn();
    if (body.status && body.status !== status) {
      requireScope(req, 'manage');
      status = body.status;
    }

    const info = db
      .prepare(
        `INSERT INTO bugs
           (title, description, steps, expected, actual, severity, kind,
            stack_trace, stack_fingerprint,
            app_version, environment, status, position, reporter_id, source, external_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        title,
        text(body.description, MAX_BODY, 'Description'),
        text(body.steps, MAX_BODY, 'Steps to reproduce'),
        text(body.expected, MAX_BODY, 'Expected result'),
        text(body.actual, MAX_BODY, 'Actual result'),
        severity,
        kind,
        stackTrace,
        fingerprint,
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

    return reply.code(201).send({ bug: serializeDetail(requireBug(id), canSeeStackTrace(req)), created: true });
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

    // Retyping a ticket — "this is not a bug, it is a request" — is a triage
    // decision, so it needs manage rather than the looser edit rule.
    let kind = bug.kind;
    if (body.kind !== undefined && body.kind !== bug.kind) {
      requireScope(req, 'manage');
      if (!isKind(body.kind)) throw new HttpError(400, `Unknown kind "${body.kind}"`);
      kind = body.kind;
      sets.push('kind = ?');
      params.push(kind);

      // The scales are parallel but share no keys, so a level that is not
      // being set explicitly has to be carried across by position.
      if (body.severity === undefined) {
        sets.push('severity = ?');
        params.push(translateLevel(bug.kind, kind, bug.severity));
      }
    }

    if (body.severity !== undefined) {
      if (!isLevelOf(kind, body.severity)) {
        throw new HttpError(
          400,
          `"${String(body.severity)}" is not a level for a ${kind} — expected one of ` +
            levelsFor(kind)
              .map((l) => l.key)
              .join(', '),
        );
      }
      sets.push('severity = ?');
      params.push(body.severity);
    }

    if (body.stackTrace !== undefined) {
      const raw = text(body.stackTrace, MAX_TRACE, 'Stack trace');
      sets.push('stack_trace = ?', 'stack_fingerprint = ?');
      params.push(raw ? normalizeStackTrace(raw) : '', raw ? fingerprintStackTrace(raw) : null);
    }

    if (!sets.length) return { bug: serializeDetail(bug, canSeeStackTrace(req)) };

    sets.push(`updated_at = datetime('now')`);
    params.push(bug.id);
    db.prepare(`UPDATE bugs SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    logEvent(bug.id, actor.user.id, 'edited', JSON.stringify({ fields: Object.keys(body) }));
    return { bug: serializeDetail(requireBug(bug.id), canSeeStackTrace(req)) };
  });

  /** Drag a card to another column, or reorder it within one. */
  app.post<{ Params: { id: string }; Body: { status?: string; index?: number } }>(
    '/api/bugs/:id/move',
    async (req) => {
      const actor = requireScope(req, 'manage');
      const { status, index } = req.body ?? {};
      if (!status) throw new HttpError(400, 'status is required');

      moveBug(bugId(req.params.id), status, index, actor.user.id);
      return { bug: serializeDetail(requireBug(bugId(req.params.id)), canSeeStackTrace(req)) };
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
        bug: serializeDetail(dup, canSeeStackTrace(req)),
        into: serializeDetail(requireBug(dup.merged_into_id!), canSeeStackTrace(req)),
      };
    },
  );

  app.post<{ Params: { id: string } }>('/api/bugs/:id/unmerge', async (req) => {
    const actor = requireScope(req, 'manage');
    return { bug: serializeDetail(unmergeBug(bugId(req.params.id), actor.user.id), canSeeStackTrace(req)) };
  });

  /** Assign, unassign, or (for a manager) take a bug themselves. */
  /**
   * "This cannot start until that is done." Triage, so it needs manage — the
   * same bar as moving a card, which is the decision it usually accompanies.
   */
  app.post<{ Params: { id: string }; Body: { blockerId?: number } }>(
    '/api/bugs/:id/blockers',
    async (req, reply) => {
      const actor = requireScope(req, 'manage');
      const blockedId = bugId(req.params.id);
      const blockerId = Number(req.body?.blockerId);

      if (!Number.isInteger(blockerId)) throw new HttpError(400, 'blockerId is required');

      addBlocker(blockedId, blockerId, actor.user.id);
      return reply.code(201).send({
        bug: serializeDetail(requireBug(blockedId), canSeeStackTrace(req)),
      });
    },
  );

  app.delete<{ Params: { id: string; blockerId: string } }>(
    '/api/bugs/:id/blockers/:blockerId',
    async (req) => {
      const actor = requireScope(req, 'manage');
      const blockedId = bugId(req.params.id);

      removeBlocker(blockedId, bugId(req.params.blockerId), actor.user.id);
      return { bug: serializeDetail(requireBug(blockedId), canSeeStackTrace(req)) };
    },
  );

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

      return { bug: serializeDetail(requireBug(bug.id), canSeeStackTrace(req)) };
    },
  );

  /**
   * Delete a bug outright — moderation, for spam and mistakes. There is no
   * undo, so it is manager-only and the UI asks twice.
   */
  app.delete<{ Params: { id: string } }>('/api/bugs/:id', async (req) => {
    const actor = requireScope(req, 'manage');
    const bug = requireBug(bugId(req.params.id));

    const result = await deleteBug(bug.id, actor.user.id);

    // Nothing survives the row to record this on, so the log is the audit trail.
    req.log.info(
      {
        bug: bug.id,
        title: bug.title,
        by: actor.user.name,
        releasedDuplicates: result.released,
        filesRemoved: result.filesRemoved,
      },
      'bug deleted',
    );

    return { ok: true, deleted: bug.id, ...result };
  });

  /**
   * Delete one comment. Manager-only: letting authors remove their own would
   * let someone erase what a reply is answering.
   */
  app.delete<{ Params: { id: string } }>('/api/comments/:id', async (req) => {
    const actor = requireScope(req, 'manage');

    const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(Number(req.params.id)) as
      | { id: number; bug_id: number; author_id: number | null; body: string }
      | undefined;
    if (!row) throw new HttpError(404, 'No such comment');

    const author = db.prepare(`SELECT name FROM users WHERE id = ?`).get(row.author_id ?? -1) as
      | { name: string }
      | undefined;

    db.prepare(`DELETE FROM comments WHERE id = ?`).run(row.id);
    logEvent(
      row.bug_id,
      actor.user.id,
      'comment_deleted',
      JSON.stringify({ author: author?.name ?? 'someone' }),
    );

    return { bug: serializeDetail(requireBug(row.bug_id), canSeeStackTrace(req)) };
  });

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

      return reply.code(201).send({ bug: serializeDetail(requireBug(bug.id), canSeeStackTrace(req)) });
    },
  );
}
