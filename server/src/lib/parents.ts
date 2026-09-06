import { db, logEvent, type BugRow } from '../db.js';
import { HttpError } from '../auth/identity.js';
import { requireBug } from './bugs.js';

/**
 * "This is part of that." A ticket has at most one parent; a parent has any
 * number of sub-tickets. The link lives on the child row (`parent_id`), so
 * there is no edge table to keep in step and nothing to cascade by hand.
 */

/**
 * A ticket that can stand as a parent, or be given one.
 *
 * A merged duplicate has left the board: it is not a place to hang work under,
 * and work should not be hung under something nobody will look at again.
 */
export function requireParentable(id: number): BugRow {
  const bug = requireBug(id);
  if (bug.merged_into_id !== null) {
    throw new HttpError(409, `#${bug.id} is merged into #${bug.merged_into_id}; unmerge it first`);
  }
  return bug;
}

/**
 * Would making `parentId` the parent of `childId` close a loop? Walk up from
 * the would-be parent; if that climb reaches the child, the child is already an
 * ancestor of it and the chain would never end.
 */
function wouldCycle(childId: number, parentId: number): boolean {
  const seen = new Set<number>();
  let current: number | null = parentId;

  while (current !== null) {
    if (current === childId) return true;
    if (seen.has(current)) return false; // defensive: never loop on bad data
    seen.add(current);

    const row = db.prepare(`SELECT parent_id FROM bugs WHERE id = ?`).get(current) as
      | { parent_id: number | null }
      | undefined;
    current = row?.parent_id ?? null;
  }

  return false;
}

/** Put `childId` under `parentId`, replacing whatever parent it had. */
export function setParent(childId: number, parentId: number, actorId: number | null): void {
  if (childId === parentId) {
    throw new HttpError(400, 'A ticket cannot be its own parent');
  }

  const child = requireParentable(childId);
  const parent = requireParentable(parentId);

  // Already there: nothing to change, nothing to log.
  if (child.parent_id === parent.id) return;

  if (wouldCycle(child.id, parent.id)) {
    throw new HttpError(
      409,
      `#${parent.id} is already under #${child.id}, directly or through another ticket — ` +
        'a ticket cannot contain itself',
    );
  }

  const previous = child.parent_id;

  db.prepare(`UPDATE bugs SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    parent.id,
    child.id,
  );

  if (previous !== null) {
    logEvent(previous, actorId, 'child_removed', JSON.stringify({ child: child.id }));
  }
  logEvent(child.id, actorId, 'parent_set', JSON.stringify({ parent: parent.id }));
  logEvent(parent.id, actorId, 'child_added', JSON.stringify({ child: child.id }));
}

export function clearParent(childId: number, actorId: number | null): void {
  const child = requireBug(childId);
  if (child.parent_id === null) throw new HttpError(404, `#${child.id} has no parent`);

  const previous = child.parent_id;

  db.prepare(`UPDATE bugs SET parent_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(
    child.id,
  );

  logEvent(child.id, actorId, 'parent_cleared', JSON.stringify({ parent: previous }));
  logEvent(previous, actorId, 'child_removed', JSON.stringify({ child: child.id }));
}
