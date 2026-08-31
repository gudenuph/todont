import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db, logEvent } from '../db.js';
import { attach, isViewable, receiveFiles, requireComment, room } from '../lib/uploads.js';
import { HttpError, canSeeStackTrace, requireScope, type Actor } from '../auth/identity.js';
import { requireBug, serializeDetail } from '../lib/bugs.js';
import type { BugRow } from '../db.js';

interface AttachmentRow {
  id: number;
  bug_id: number;
  comment_id: number | null;
  filename: string;
  original_name: string;
  mime: string;
  size: number;
  uploaded_by: number | null;
}

/**
 * A single `bytes=` range, clamped to the file. Returns null when the client
 * asked for the whole file, and 'unsatisfiable' when it asked for something
 * outside it (which is a 416, not a 200 with the wrong bytes).
 *
 * Multi-range requests are deliberately answered with the whole file: they are
 * legal but no browser media player issues them.
 */
function parseRange(
  header: string | undefined,
  total: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;

  if (rawStart === '') {
    // A suffix range — "bytes=-500" means the last 500 bytes.
    const wanted = Number(rawEnd);
    if (wanted <= 0) return 'unsatisfiable';
    start = Math.max(0, total - wanted);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= total || start > end) return 'unsatisfiable';

  return { start, end: Math.min(end, total - 1) };
}

/** Same rule as editing: the reporter while untriaged, or any manager. */
function assertCanAttach(actor: Actor, bug: BugRow): void {
  if (actor.scopes.has('manage')) return;
  if (bug.reporter_id === actor.user.id) return;
  throw new HttpError(403, 'You can only attach files to your own bugs');
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/api/bugs/:id/attachments', async (req, reply) => {
    const actor = requireScope(req, 'write');
    const bug = requireBug(Number(req.params.id));
    assertCanAttach(actor, bug);

    const { files } = await receiveFiles(req, room(bug.id, null));
    if (!files.length) throw new HttpError(400, 'No file was uploaded');

    attach(files, bug.id, null, actor.user.id);

    db.prepare(`UPDATE bugs SET updated_at = datetime('now') WHERE id = ?`).run(bug.id);
    logEvent(bug.id, actor.user.id, 'attachment_added', JSON.stringify({ count: files.length }));

    return reply.code(201).send({ bug: serializeDetail(requireBug(bug.id), canSeeStackTrace(req)) });
  });

  /**
   * Images on an existing comment.
   *
   * The comment can also be posted with its files in one request — see
   * `POST /api/bugs/:id/comments` — which is what the web form and most API
   * callers want. This is for adding to one that is already there.
   */
  app.post<{ Params: { id: string } }>('/api/comments/:id/attachments', async (req, reply) => {
    const actor = requireScope(req, 'write');
    const comment = requireComment(Number(req.params.id));

    // Your own comment, or a manager's to any. Same shape as editing.
    if (!actor.scopes.has('manage') && comment.author_id !== actor.user.id) {
      throw new HttpError(403, 'You can only add images to your own comments');
    }

    const { files } = await receiveFiles(req, room(comment.bug_id, comment.id));
    if (!files.length) throw new HttpError(400, 'No file was uploaded');

    attach(files, comment.bug_id, comment.id, actor.user.id);

    db.prepare(`UPDATE bugs SET updated_at = datetime('now') WHERE id = ?`).run(comment.bug_id);
    logEvent(
      comment.bug_id,
      actor.user.id,
      'attachment_added',
      JSON.stringify({ count: files.length, onComment: true }),
    );

    return reply
      .code(201)
      .send({ bug: serializeDetail(requireBug(comment.bug_id), canSeeStackTrace(req)) });
  });

  /**
   * Public, like the rest of the board.
   *
   * Served as a stream with byte-range support, which video needs: a browser
   * cannot seek without it, and Safari refuses to play a video at all if the
   * response is not ranged. Streaming also keeps a 50MB screen recording off
   * the heap.
   */
  app.get<{ Params: { id: string } }>('/api/attachments/:id', async (req, reply) => {
    const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(Number(req.params.id)) as
      | AttachmentRow
      | undefined;
    if (!row) throw new HttpError(404, 'No such attachment');

    const file = path.join(config.uploadDir, row.filename);
    let total: number;
    try {
      total = (await fs.stat(file)).size;
    } catch {
      throw new HttpError(404, 'That attachment is no longer on disk');
    }

    reply
      .header('content-type', row.mime)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `${isViewable(row.mime) ? 'inline' : 'attachment'}; filename="${row.original_name.replace(/["\\\r\n]/g, '_')}"`,
      );

    const range = parseRange(req.headers.range, total);

    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${total}`).send();
    }

    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${total}`)
        .header('content-length', String(range.end - range.start + 1))
        .send(createReadStream(file, { start: range.start, end: range.end }));
    }

    return reply.header('content-length', String(total)).send(createReadStream(file));
  });

  app.delete<{ Params: { id: string } }>('/api/attachments/:id', async (req) => {
    const actor = requireScope(req, 'write');
    const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(Number(req.params.id)) as
      | AttachmentRow
      | undefined;
    if (!row) throw new HttpError(404, 'No such attachment');

    if (!actor.scopes.has('manage') && row.uploaded_by !== actor.user.id) {
      throw new HttpError(403, 'You can only remove attachments you uploaded');
    }

    db.prepare(`DELETE FROM attachments WHERE id = ?`).run(row.id);
    await fs.rm(path.join(config.uploadDir, row.filename), { force: true });
    logEvent(row.bug_id, actor.user.id, 'attachment_removed', JSON.stringify({ name: row.original_name }));

    return { bug: serializeDetail(requireBug(row.bug_id), canSeeStackTrace(req)) };
  });
}
