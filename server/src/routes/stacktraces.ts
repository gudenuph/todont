import type { FastifyInstance } from 'fastify';
import { db, logEvent, type BugRow } from '../db.js';
import { HttpError, canSeeStackTrace, requireScope } from '../auth/identity.js';
import { fingerprintStackTrace, normalizeStackTrace } from '../lib/stacktrace.js';
import { requireBug, resolveCanonical, serializeCard, serializeDetail } from '../lib/bugs.js';

const MAX_TRACE = 20_000;

/**
 * Find the bug already holding this fingerprint, following a merge so the
 * answer is the ticket that is actually on the board rather than a duplicate
 * somebody folded away.
 */
export function findByFingerprint(fingerprint: string): BugRow | undefined {
  const match = db
    .prepare(
      `SELECT * FROM bugs
       WHERE stack_fingerprint = ?
       ORDER BY merged_into_id IS NOT NULL, id
       LIMIT 1`,
    )
    .get(fingerprint) as BugRow | undefined;

  return match ? resolveCanonical(match) : undefined;
}

/** Another sighting of a known crash. Counted on the live ticket. */
export function recordOccurrence(bug: BugRow, actorId: number | null): BugRow {
  db.prepare(
    `UPDATE bugs SET occurrences = occurrences + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(bug.id);

  const updated = requireBug(bug.id);

  // Only note it in the activity trail at round numbers. A crash hit ten
  // thousand times would otherwise bury every real comment on the ticket.
  if ([10, 50, 100, 500, 1000, 5000, 10_000].includes(updated.occurrences)) {
    logEvent(bug.id, actorId, 'occurrence_milestone', JSON.stringify({ count: updated.occurrences }));
  }

  return updated;
}

export async function stackTraceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * "Have you seen this crash?" — the call ezmuze makes before deciding whether
   * to raise anything.
   *
   * A hit counts the sighting and answers `raised: true` with the ticket, so
   * the client can show the user it is already known. A miss answers
   * `raised: false` and hands back the fingerprint, which the client can pass
   * straight to POST /api/bugs.
   */
  app.post<{ Body: { stackTrace?: string } }>('/api/stack-traces/check', async (req) => {
    const actor = requireScope(req, 'write');
    const raw = req.body?.stackTrace ?? '';

    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new HttpError(400, 'stackTrace is required');
    }
    if (raw.length > MAX_TRACE) {
      throw new HttpError(400, `stackTrace is too long (max ${MAX_TRACE} characters)`);
    }

    const fingerprint = fingerprintStackTrace(raw);
    if (!fingerprint) {
      throw new HttpError(
        400,
        'That is too short to identify a crash — send the whole stack trace',
      );
    }

    const existing = findByFingerprint(fingerprint);

    if (!existing) {
      return {
        raised: false,
        fingerprint,
        // Handed back so the caller can see exactly what it will be matched on.
        normalized: normalizeStackTrace(raw),
      };
    }

    const updated = recordOccurrence(existing, actor.user.id);

    app.log.info(
      { bug: updated.id, occurrences: updated.occurrences, fingerprint },
      'known crash seen again',
    );

    return {
      raised: true,
      fingerprint,
      occurrences: updated.occurrences,
      bug: serializeCard({
        ...updated,
        comment_count: 0,
        attachment_count: 0,
        duplicate_count: 0,
      }),
      url: `/api/bugs/${updated.id}`,
    };
  });

  /** The full ticket behind a fingerprint, for a client that wants to show it. */
  app.get<{ Params: { fingerprint: string } }>(
    '/api/stack-traces/:fingerprint',
    async (req) => {
      const existing = findByFingerprint(req.params.fingerprint);
      if (!existing) throw new HttpError(404, 'No bug has that stack trace');
      return { bug: serializeDetail(existing, canSeeStackTrace(req)) };
    },
  );
}
