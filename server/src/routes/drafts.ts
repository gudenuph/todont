import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { db } from '../db.js';
import { HttpError } from '../auth/identity.js';
import { DEFAULT_KIND, isKind } from '../columns.js';
import { fingerprintStackTrace, normalizeStackTrace } from '../lib/stacktrace.js';
import { serializeCard } from '../lib/bugs.js';
import { findByFingerprint } from './stacktraces.js';

/** Long enough for a stack trace, short enough not to be a dumping ground. */
const LIMITS: Record<string, number> = {
  title: 200,
  description: 20_000,
  steps: 20_000,
  expected: 20_000,
  actual: 20_000,
  stackTrace: 20_000,
  appVersion: 100,
  environment: 500,
  severity: 40,
  kind: 40,
};

const FIELDS = Object.keys(LIMITS);
const DRAFT_TTL_MINUTES = 60;

export interface DraftPayload {
  [field: string]: string;
}

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Hand the browser a prefilled report.
   *
   * ezmuze POSTs what it already knows — version, platform, the stack trace —
   * gets a short id back, and opens the returned URL. A stack trace will not
   * survive a query string, and putting one there would also spill it into
   * every proxy log on the way.
   *
   * Deliberately unauthenticated. Shipping a token inside a desktop app means
   * shipping it to everyone who can read the binary, and a draft is not a bug:
   * it is inert text that still needs a signed-in person to submit it. The cost
   * of abuse is rows in a table that expire in an hour, so it is rate limited
   * and capped instead of credentialed.
   */
  app.post<{ Body: Record<string, unknown> }>(
    '/api/drafts',
    { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = req.body ?? {};
      const payload: DraftPayload = {};

      for (const field of FIELDS) {
        const value = body[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') {
          throw new HttpError(400, `${field} must be text`);
        }
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (trimmed.length > LIMITS[field]) {
          throw new HttpError(400, `${field} is too long (max ${LIMITS[field]} characters)`);
        }
        payload[field] = trimmed;
      }

      if (payload.kind && !isKind(payload.kind)) {
        throw new HttpError(400, `Unknown kind "${payload.kind}"`);
      }

      // Strip the machine's own paths here rather than on submit, so a user
      // reviewing the form sees exactly what will be stored.
      if (payload.stackTrace) {
        payload.stackTrace = normalizeStackTrace(payload.stackTrace);
      }

      if (!Object.keys(payload).length) {
        throw new HttpError(400, 'A draft needs at least one field');
      }

      const id = randomBytes(9).toString('base64url');
      db.prepare(
        `INSERT INTO drafts (id, payload, expires_at)
         VALUES (?, ?, datetime('now', ?))`,
      ).run(id, JSON.stringify(payload), `+${DRAFT_TTL_MINUTES} minutes`);

      return reply.code(201).send({
        id,
        // Ready to hand straight to a browser.
        url: `${config.publicUrl}/?draft=${id}`,
        expiresInMinutes: DRAFT_TTL_MINUTES,
      });
    },
  );

  /**
   * Read a draft back. Also answers whether the crash is already on the board,
   * so the form can say so before someone writes out a report we already have.
   */
  app.get<{ Params: { id: string } }>('/api/drafts/:id', async (req) => {
    const row = db
      .prepare(`SELECT payload FROM drafts WHERE id = ? AND expires_at > datetime('now')`)
      .get(req.params.id) as { payload: string } | undefined;

    if (!row) throw new HttpError(404, 'That prefilled report has expired — raise it by hand');

    const payload = JSON.parse(row.payload) as DraftPayload;
    const kind = payload.kind && isKind(payload.kind) ? payload.kind : DEFAULT_KIND;

    let knownBug = null;
    if (payload.stackTrace) {
      const fingerprint = fingerprintStackTrace(payload.stackTrace);
      const existing = fingerprint ? findByFingerprint(fingerprint) : undefined;
      if (existing) {
        knownBug = serializeCard({
          ...existing,
          comment_count: 0,
          attachment_count: 0,
          duplicate_count: 0,
        });
      }
    }

    return { draft: { ...payload, kind }, knownBug };
  });
}
