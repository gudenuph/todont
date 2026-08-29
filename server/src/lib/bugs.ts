import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db, logEvent, type BugRow, type UserRow } from '../db.js';
import { HttpError, publicUser } from '../auth/identity.js';
import { isColumn } from '../columns.js';

const POSITION_GAP = 1000;

export function getBug(id: number): BugRow | undefined {
  return db.prepare(`SELECT * FROM bugs WHERE id = ?`).get(id) as BugRow | undefined;
}

export function requireBug(id: number): BugRow {
  const bug = getBug(id);
  if (!bug) throw new HttpError(404, `No bug #${id}`);
  return bug;
}

function user(id: number | null | undefined): UserRow | undefined {
  if (id === null || id === undefined) return undefined;
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

/** Follow a merge chain to the bug that actually holds the discussion. */
export function resolveCanonical(bug: BugRow): BugRow {
  const seen = new Set<number>([bug.id]);
  let current = bug;
  while (current.merged_into_id !== null) {
    if (seen.has(current.merged_into_id)) break; // defensive: never loop
    const next = getBug(current.merged_into_id);
    if (!next) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

const COUNTS = `
  (SELECT COUNT(*) FROM comments c WHERE c.bug_id = b.id)      AS comment_count,
  (SELECT COUNT(*) FROM attachments a WHERE a.bug_id = b.id)   AS attachment_count,
  (SELECT COUNT(*) FROM bugs d WHERE d.merged_into_id = b.id)  AS duplicate_count
`;

type CardRow = BugRow & {
  comment_count: number;
  attachment_count: number;
  duplicate_count: number;
};

export function serializeCard(b: CardRow) {
  return {
    id: b.id,
    title: b.title,
    severity: b.severity,
    status: b.status,
    position: b.position,
    source: b.source,
    externalRef: b.external_ref,
    reporter: publicUser(user(b.reporter_id)),
    assignee: publicUser(user(b.assignee_id)),
    commentCount: b.comment_count,
    attachmentCount: b.attachment_count,
    duplicateCount: b.duplicate_count,
    mergedIntoId: b.merged_into_id,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

interface AttachmentRow {
  id: number;
  original_name: string;
  mime: string;
  size: number;
  uploaded_by: number | null;
  created_at: string;
}

export function serializeDetail(b: BugRow) {
  const counts = db
    .prepare(`SELECT ${COUNTS} FROM bugs b WHERE b.id = ?`)
    .get(b.id) as Pick<CardRow, 'comment_count' | 'attachment_count' | 'duplicate_count'>;

  const attachments = db
    .prepare(`SELECT * FROM attachments WHERE bug_id = ? ORDER BY id`)
    .all(b.id) as AttachmentRow[];

  const comments = db
    .prepare(`SELECT * FROM comments WHERE bug_id = ? ORDER BY id`)
    .all(b.id) as Array<{ id: number; author_id: number | null; body: string; created_at: string }>;

  const events = db
    .prepare(`SELECT * FROM events WHERE bug_id = ? ORDER BY id`)
    .all(b.id) as Array<{
    id: number;
    actor_id: number | null;
    type: string;
    detail: string;
    created_at: string;
  }>;

  const duplicates = db
    .prepare(`SELECT b.*, ${COUNTS} FROM bugs b WHERE b.merged_into_id = ? ORDER BY b.id`)
    .all(b.id) as CardRow[];

  return {
    ...serializeCard({ ...b, ...counts }),
    description: b.description,
    steps: b.steps,
    expected: b.expected,
    actual: b.actual,
    appVersion: b.app_version,
    environment: b.environment,
    attachments: attachments.map((a) => ({
      id: a.id,
      url: `/api/attachments/${a.id}`,
      name: a.original_name,
      mime: a.mime,
      size: a.size,
      uploadedBy: publicUser(user(a.uploaded_by)),
      createdAt: a.created_at,
    })),
    comments: comments.map((c) => ({
      id: c.id,
      author: publicUser(user(c.author_id)),
      body: c.body,
      createdAt: c.created_at,
    })),
    events: events.map((e) => ({
      id: e.id,
      actor: publicUser(user(e.actor_id)),
      type: e.type,
      detail: e.detail,
      createdAt: e.created_at,
    })),
    duplicates: duplicates.map((d) => ({ ...serializeCard(d), description: d.description })),
  };
}

export interface ListFilters {
  status?: string;
  q?: string;
  assigneeId?: number;
  /** "My bugs": raised by this user, or waiting on them. */
  mineUserId?: number;
  includeMerged?: boolean;
  limit?: number;
}

export function listBugs(filters: ListFilters = {}) {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!filters.includeMerged) where.push('b.merged_into_id IS NULL');

  if (filters.status) {
    if (!isColumn(filters.status)) throw new HttpError(400, `Unknown column "${filters.status}"`);
    where.push('b.status = ?');
    params.push(filters.status);
  }

  if (filters.assigneeId !== undefined) {
    where.push('b.assignee_id = ?');
    params.push(filters.assigneeId);
  }

  if (filters.mineUserId !== undefined) {
    where.push('(b.reporter_id = ? OR b.assignee_id = ?)');
    params.push(filters.mineUserId, filters.mineUserId);
  }

  if (filters.q) {
    where.push('(b.title LIKE ? OR b.description LIKE ? OR b.steps LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }

  const sql = `
    SELECT b.*, ${COUNTS} FROM bugs b
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY b.status, b.position, b.id
    LIMIT ?`;

  params.push(Math.min(filters.limit ?? 2000, 5000));
  return (db.prepare(sql).all(...params) as CardRow[]).map(serializeCard);
}

/**
 * Put `bugId` into `status` at `index`, renumbering that column.
 *
 * Renumbering the whole column rather than bisecting between neighbours keeps
 * positions exact — a board this size never has enough cards for the extra
 * writes to matter, and there is no fractional drift to repair later.
 */
export function moveBug(
  bugId: number,
  status: string,
  index: number | undefined,
  actorId: number | null,
): BugRow {
  if (!isColumn(status)) throw new HttpError(400, `Unknown column "${status}"`);

  const bug = requireBug(bugId);
  if (bug.merged_into_id !== null) {
    throw new HttpError(409, `#${bug.id} is merged into #${bug.merged_into_id}; unmerge it first`);
  }

  const from = bug.status;

  const move = db.transaction(() => {
    const others = db
      .prepare(
        `SELECT id FROM bugs
         WHERE status = ? AND merged_into_id IS NULL AND id != ?
         ORDER BY position, id`,
      )
      .all(status, bugId) as Array<{ id: number }>;

    const at = Math.max(0, Math.min(index ?? others.length, others.length));
    const ordered = [...others.slice(0, at), { id: bugId }, ...others.slice(at)];

    const setPos = db.prepare(`UPDATE bugs SET position = ? WHERE id = ?`);
    ordered.forEach((row, i) => setPos.run((i + 1) * POSITION_GAP, row.id));

    db.prepare(`UPDATE bugs SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
      status,
      bugId,
    );
  });

  move();

  if (from !== status) {
    logEvent(bugId, actorId, 'status_changed', JSON.stringify({ from, to: status }));
  }

  return requireBug(bugId);
}

/** Mark `bugId` a duplicate of `intoId`. */
export function mergeBug(bugId: number, intoId: number, actorId: number | null): BugRow {
  if (bugId === intoId) throw new HttpError(400, 'A bug cannot be a duplicate of itself');

  const dup = requireBug(bugId);
  const target = requireBug(intoId);

  if (dup.merged_into_id !== null) {
    throw new HttpError(409, `#${dup.id} is already merged into #${dup.merged_into_id}`);
  }

  // Merge into whatever the target itself resolves to, so chains stay one deep,
  // and refuse anything that would close a loop.
  const canonical = resolveCanonical(target);
  if (canonical.id === dup.id) {
    throw new HttpError(409, `That would make #${dup.id} a duplicate of itself`);
  }

  const run = db.transaction(() => {
    // Anything already pointing at the duplicate follows it to the new home.
    db.prepare(`UPDATE bugs SET merged_into_id = ? WHERE merged_into_id = ?`).run(
      canonical.id,
      dup.id,
    );
    db.prepare(`UPDATE bugs SET merged_into_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
      canonical.id,
      dup.id,
    );
  });

  run();

  logEvent(dup.id, actorId, 'merged', JSON.stringify({ into: canonical.id }));
  logEvent(canonical.id, actorId, 'duplicate_added', JSON.stringify({ duplicate: dup.id }));

  return requireBug(dup.id);
}

/**
 * Remove a bug outright — the moderation escape hatch for spam and mistakes.
 *
 * Comments, attachment rows and the activity log go with it through the
 * schema's cascades, but two things need doing by hand: duplicates merged into
 * it are released back onto their columns first (otherwise the foreign key
 * quietly nulls their `merged_into_id` and they reappear at a stale position),
 * and the uploaded files are unlinked from disk after the row is gone.
 */
export async function deleteBug(
  bugId: number,
  actorId: number | null,
): Promise<{ released: number[]; filesRemoved: number }> {
  const bug = requireBug(bugId);

  const duplicates = db
    .prepare(`SELECT id FROM bugs WHERE merged_into_id = ?`)
    .all(bug.id) as Array<{ id: number }>;

  const files = db
    .prepare(`SELECT filename FROM attachments WHERE bug_id = ?`)
    .all(bug.id) as Array<{ filename: string }>;

  const run = db.transaction(() => {
    for (const dup of duplicates) unmergeBug(dup.id, actorId);
    db.prepare(`DELETE FROM bugs WHERE id = ?`).run(bug.id);
  });

  run();

  let filesRemoved = 0;
  for (const file of files) {
    try {
      await fs.rm(path.join(config.uploadDir, file.filename), { force: true });
      filesRemoved++;
    } catch {
      // The row is already gone; a leftover file is not worth failing the call.
    }
  }

  return { released: duplicates.map((d) => d.id), filesRemoved };
}

export function unmergeBug(bugId: number, actorId: number | null): BugRow {
  const dup = requireBug(bugId);
  if (dup.merged_into_id === null) throw new HttpError(409, `#${dup.id} is not a duplicate`);

  const wasInto = dup.merged_into_id;
  db.prepare(`UPDATE bugs SET merged_into_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(
    dup.id,
  );

  logEvent(dup.id, actorId, 'unmerged', JSON.stringify({ from: wasInto }));
  logEvent(wasInto, actorId, 'duplicate_removed', JSON.stringify({ duplicate: dup.id }));

  // Send it back to the end of its column so it is visible again.
  return moveBug(dup.id, dup.status, undefined, actorId);
}
