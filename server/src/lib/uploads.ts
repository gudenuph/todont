import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { settingInt } from './settings.js';
import { HttpError } from '../auth/identity.js';
import { db } from '../db.js';

/**
 * Receiving uploaded files, in one place.
 *
 * Bugs and comments both take images, and the rules — which types, how big,
 * how many, and what to do when one of those is broken halfway through a
 * stream — should not be written twice and drift apart.
 *
 * Files land on disk here but no row is written: the caller decides what the
 * file belongs to, which is what lets a comment and its images be created in
 * one request even though the comment does not exist until the files are read.
 */

/**
 * SVG is deliberately absent: it is a script-bearing document, and these files
 * are served from the same origin as the app.
 */
export const ALLOWED: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/webm': '.webm',
  'video/mp4': '.mp4',
  'text/plain': '.txt',
  'application/pdf': '.pdf',
};

/** Shown inline rather than offered as a download. */
export function isViewable(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('video/');
}

export interface ReceivedFile {
  filename: string;
  originalName: string;
  mime: string;
  size: number;
}

export interface Received {
  files: ReceivedFile[];
  /** Ordinary form fields alongside the files — a comment's text, say. */
  fields: Record<string, string>;
}

/**
 * Read a multipart body: files to disk, other parts as text.
 *
 * `limit` is how many more files this target can accept. Anything already
 * written is removed if a later part is rejected, so a refused request leaves
 * nothing behind.
 */
export async function receiveFiles(req: FastifyRequest, limit: number): Promise<Received> {
  // The parser's ceiling was fixed at boot; this is the instance's own limit
  // within it, so lowering it in the admin panel takes effect immediately.
  const maxBytes = settingInt('uploads.maxBytes');

  const files: ReceivedFile[] = [];
  const fields: Record<string, string> = {};
  const written: string[] = [];

  const cleanUp = async () => {
    await Promise.all(written.map((p) => fs.rm(p, { force: true })));
  };

  try {
    for await (const part of req.parts({ limits: { fileSize: maxBytes } })) {
      if (part.type !== 'file') {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value;
        continue;
      }

      if (files.length >= limit) {
        throw new HttpError(
          400,
          limit === 0
            ? 'That has as many attachments as it can hold'
            : `At most ${limit} more file(s) can be attached`,
        );
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
      written.push(target);

      await pipeline(part.file, createWriteStream(target));

      // @fastify/multipart flags this once the byte cap is hit mid-stream.
      if (part.file.truncated) {
        throw new HttpError(
          413,
          `${part.filename || 'That file'} is larger than ${Math.round(maxBytes / 1024 / 1024)}MB`,
        );
      }

      files.push({
        filename,
        originalName: part.filename || filename,
        mime,
        size: (await fs.stat(target)).size,
      });
    }
  } catch (err) {
    await cleanUp();
    throw err;
  }

  return { files, fields };
}

/** Remove files whose rows have gone, so a delete does not leak disk. */
export async function removeFiles(filenames: string[]): Promise<void> {
  await Promise.all(
    filenames.map((name) => fs.rm(path.join(config.uploadDir, name), { force: true })),
  );
}

export interface CommentRow {
  id: number;
  bug_id: number;
  author_id: number | null;
  body: string;
}

export function requireComment(id: number): CommentRow {
  const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as CommentRow | undefined;
  if (!row) throw new HttpError(404, 'No such comment');
  return row;
}

/**
 * How many more files this target will take.
 *
 * The cap applies per gallery and per comment rather than per bug: a long
 * thread with a screenshot on each reply is normal, and counting them against
 * the bug's own limit would stop the conversation once the gallery filled up.
 */
export function room(bugId: number, commentId: number | null): number {
  const held = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM attachments
          WHERE bug_id = ? AND comment_id IS ?`,
      )
      .get(bugId, commentId) as { n: number }
  ).n;

  return Math.max(0, settingInt('uploads.maxPerBug') - held);
}

/** Write the rows for files already on disk. */
export function attach(
  files: ReceivedFile[],
  bugId: number,
  commentId: number | null,
  uploadedBy: number,
): number[] {
  const insert = db.prepare(
    `INSERT INTO attachments (bug_id, comment_id, filename, original_name, mime, size, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  return db.transaction(() =>
    files.map(
      (f) =>
        Number(
          insert.run(bugId, commentId, f.filename, f.originalName, f.mime, f.size, uploadedBy)
            .lastInsertRowid,
        ),
    ),
  )();
}
