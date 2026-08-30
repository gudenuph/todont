import { db, logEvent, type BugRow } from '../db.js';
import { HttpError } from '../auth/identity.js';
import { requireBug } from './bugs.js';

export interface BlockEdges {
  /** Ticket ids this one is waiting on. */
  blockedBy: number[];
  /** Ticket ids waiting on this one. */
  blocking: number[];
}

const EMPTY: BlockEdges = { blockedBy: [], blocking: [] };

/**
 * Every edge on the board, in one query.
 *
 * The board draws a blocked card differently and dims unrelated cards on hover,
 * so it needs the edges for *every* card it renders. Asking per card would be a
 * query per ticket for something this small.
 */
export function allBlockEdges(): Map<number, BlockEdges> {
  const rows = db.prepare(`SELECT blocked_id, blocker_id FROM blocks`).all() as Array<{
    blocked_id: number;
    blocker_id: number;
  }>;

  const map = new Map<number, BlockEdges>();
  const get = (id: number): BlockEdges => {
    let edges = map.get(id);
    if (!edges) {
      edges = { blockedBy: [], blocking: [] };
      map.set(id, edges);
    }
    return edges;
  };

  for (const row of rows) {
    get(row.blocked_id).blockedBy.push(row.blocker_id);
    get(row.blocker_id).blocking.push(row.blocked_id);
  }

  return map;
}

export function blockEdgesFor(bugId: number): BlockEdges {
  return {
    blockedBy: (
      db.prepare(`SELECT blocker_id AS id FROM blocks WHERE blocked_id = ? ORDER BY blocker_id`).all(bugId) as Array<{ id: number }>
    ).map((r) => r.id),
    blocking: (
      db.prepare(`SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? ORDER BY blocked_id`).all(bugId) as Array<{ id: number }>
    ).map((r) => r.id),
  };
}

export { EMPTY as NO_BLOCKS };

/**
 * Would "A is blocked by B" close a loop? Walk what B is itself waiting on; if
 * that reaches A, the two would be waiting on each other and neither could ever
 * be unblocked.
 */
function wouldCycle(blockedId: number, blockerId: number): boolean {
  const seen = new Set<number>();
  const queue = [blockerId];

  while (queue.length) {
    const current = queue.shift()!;
    if (current === blockedId) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    const next = db
      .prepare(`SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?`)
      .all(current) as Array<{ id: number }>;
    for (const row of next) queue.push(row.id);
  }

  return false;
}

export function addBlocker(blockedId: number, blockerId: number, actorId: number | null): void {
  if (blockedId === blockerId) {
    throw new HttpError(400, 'A ticket cannot block itself');
  }

  const blocked = requireBug(blockedId);
  const blocker = requireBug(blockerId);

  const existing = db
    .prepare(`SELECT 1 FROM blocks WHERE blocked_id = ? AND blocker_id = ?`)
    .get(blockedId, blockerId);
  if (existing) throw new HttpError(409, `#${blockedId} is already blocked by #${blockerId}`);

  if (wouldCycle(blockedId, blockerId)) {
    throw new HttpError(
      409,
      `#${blockerId} is already waiting on #${blockedId}, directly or through another ticket — ` +
        'that would leave both stuck for good',
    );
  }

  db.prepare(
    `INSERT INTO blocks (blocked_id, blocker_id, created_by) VALUES (?, ?, ?)`,
  ).run(blocked.id, blocker.id, actorId);

  logEvent(blocked.id, actorId, 'blocked_by_added', JSON.stringify({ blocker: blocker.id }));
  logEvent(blocker.id, actorId, 'now_blocking', JSON.stringify({ blocked: blocked.id }));
}

export function removeBlocker(blockedId: number, blockerId: number, actorId: number | null): void {
  const info = db
    .prepare(`DELETE FROM blocks WHERE blocked_id = ? AND blocker_id = ?`)
    .run(blockedId, blockerId);

  if (info.changes === 0) {
    throw new HttpError(404, `#${blockedId} is not blocked by #${blockerId}`);
  }

  logEvent(blockedId, actorId, 'blocked_by_removed', JSON.stringify({ blocker: blockerId }));
  logEvent(blockerId, actorId, 'no_longer_blocking', JSON.stringify({ blocked: blockedId }));
}

export type { BugRow };
