import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db, logEvent } from '../db.js';
import { HttpError, canSeeStackTrace, requireScope, type Actor } from '../auth/identity.js';
import { requireBug, serializeDetail } from '../lib/bugs.js';
import type { BugRow } from '../db.js';

/**
 * SVG is deliberately absent: it is a script-bearing document, and these files
 * are served from the same origin as the app.
 */
const ALLOWED: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'text/plain': '.txt',
  'application/pdf': '.pdf',
};

/** Shown inline in the bug rather than offered as a download. */
function isViewable(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('video/');
}

interface AttachmentRow {
  id: number;
  bug_id: number;
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

    const existing = (
      db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE bug_id = ?`).get(bug.id) as {
        n: number;
      }
    ).n;

    const saved: number[] = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;

      if (existing + saved.length >= config.maxUploadsPerBug) {
        throw new HttpError(400, `A bug can hold at most ${config.maxUploadsPerBug} attachments`);
      }

      const mime = (part.mimetype || '').toLowerCase();
      const ext = ALLOWED[mime];
      if (!ext) {
        throw new HttpError(
          415,
          `${part.filename || 'That file'} is not an accepted type ` +
            '(PNG, JPEG, GIF, WebP, WebM, MP4, PDF or plain text)',
        );
      }

      const filename = `${randomUUID()}${ext}`;
      const target = path.join(config.uploadDir, filename);

      await pipeline(part.file, createWriteStream(target));

      // @fastify/multipart flags this once the byte cap is hit mid-stream.
      if (part.file.truncated) {
        await fs.rm(target, { force: true });
        throw new HttpError(
          413,
          `${part.filename || 'That file'} is larger than ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB`,
        );
      }

      const { size } = await fs.stat(target);
      const info = db
        .prepare(
          `INSERT INTO attachments (bug_id, filename, original_name, mime, size, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(bug.id, filename, part.filename || filename, mime, size, actor.user.id);

      saved.push(Number(info.lastInsertRowid));
    }

    if (!saved.length) throw new HttpError(400, 'No file was uploaded');

    db.prepare(`UPDATE bugs SET updated_at = datetime('now') WHERE id = ?`).run(bug.id);
    logEvent(bug.id, actor.user.id, 'attachment_added', JSON.stringify({ count: saved.length }));

    return reply.code(201).send({ bug: serializeDetail(requireBug(bug.id), canSeeStackTrace(req)) });
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
