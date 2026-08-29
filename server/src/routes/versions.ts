import type { FastifyInstance } from 'fastify';
import { db, UNRELEASED_VERSION } from '../db.js';
import { HttpError, requireScope } from '../auth/identity.js';

const MAX_NAME = 60;

export interface VersionRow {
  id: number;
  name: string;
  released_at: string | null;
  is_unreleased: number;
  created_at: string;
}

/**
 * Newest release first, with the unreleased entry pinned to the bottom.
 *
 * The order is the dropdown's order, and the first row is what a new report
 * defaults to — so a reporter on the current build picks nothing at all, and
 * "Unreleased" is a deliberate scroll to the end rather than an easy mis-click.
 */
export function listVersions(): VersionRow[] {
  return db
    .prepare(
      `SELECT * FROM versions
       ORDER BY is_unreleased ASC, released_at DESC, id DESC`,
    )
    .all() as VersionRow[];
}

export function serializeVersion(v: VersionRow) {
  return {
    id: v.id,
    name: v.name,
    releasedAt: v.released_at,
    isUnreleased: v.is_unreleased === 1,
  };
}

/** What a new report starts on: the newest actual release, if there is one. */
export function defaultVersion(): string {
  const versions = listVersions();
  return (versions.find((v) => v.is_unreleased === 0) ?? versions[0])?.name ?? '';
}

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  /** Public: the raise form needs it, and it gives away nothing. */
  app.get('/api/versions', async () => ({
    versions: listVersions().map(serializeVersion),
    default: defaultVersion(),
  }));

  /**
   * Register a release. Called by ezmuze's publishing pipeline, with a token
   * scoped to `versions` and nothing else.
   *
   * Idempotent on `name`: a pipeline that re-runs, or publishes twice, gets the
   * version it already registered back with `created: false` rather than an
   * error it would have to special-case.
   */
  app.post<{ Body: { name?: string; releasedAt?: string } }>(
    '/api/versions',
    async (req, reply) => {
      const actor = requireScope(req, 'versions');
      const name = (req.body?.name ?? '').trim();

      if (!name) throw new HttpError(400, 'name is required, e.g. "2026.9.0"');
      if (name.length > MAX_NAME) {
        throw new HttpError(400, `name is too long (max ${MAX_NAME} characters)`);
      }
      if (name.toLowerCase() === UNRELEASED_VERSION.toLowerCase()) {
        throw new HttpError(409, `"${UNRELEASED_VERSION}" is reserved`);
      }

      const existing = db.prepare(`SELECT * FROM versions WHERE name = ?`).get(name) as
        | VersionRow
        | undefined;
      if (existing) {
        return reply.code(200).send({ version: serializeVersion(existing), created: false });
      }

      // An explicit timestamp lets a pipeline backfill in the right order;
      // otherwise the release happened when it said so.
      let releasedAt = new Date().toISOString();
      if (req.body?.releasedAt) {
        const parsed = new Date(req.body.releasedAt);
        if (Number.isNaN(parsed.getTime())) {
          throw new HttpError(400, 'releasedAt must be an ISO 8601 date');
        }
        releasedAt = parsed.toISOString();
      }

      const info = db
        .prepare(`INSERT INTO versions (name, released_at, is_unreleased) VALUES (?, ?, 0)`)
        .run(name, releasedAt);

      const row = db.prepare(`SELECT * FROM versions WHERE id = ?`).get(info.lastInsertRowid) as
        | VersionRow
        | undefined;

      app.log.info({ name, releasedAt, by: actor.user.name }, 'version registered');

      return reply.code(201).send({ version: serializeVersion(row!), created: true });
    },
  );

  /**
   * Remove a version — for a pipeline that registered the wrong string. Bugs
   * store the version as text, so their history is untouched by this.
   */
  app.delete<{ Params: { id: string } }>('/api/versions/:id', async (req) => {
    requireScope(req, 'admin');

    const row = db.prepare(`SELECT * FROM versions WHERE id = ?`).get(Number(req.params.id)) as
      | VersionRow
      | undefined;
    if (!row) throw new HttpError(404, 'No such version');
    if (row.is_unreleased === 1) {
      throw new HttpError(409, `"${UNRELEASED_VERSION}" cannot be removed`);
    }

    db.prepare(`DELETE FROM versions WHERE id = ?`).run(row.id);
    return { ok: true, deleted: row.name };
  });
}
