import type { FastifyInstance } from 'fastify';
import { db, type UserRow } from '../db.js';
import {
  ALL_SCOPES,
  HttpError,
  hashToken,
  newToken,
  publicUser,
  requireScope,
  type Scope,
} from '../auth/identity.js';

const ROLES = ['user', 'manager', 'admin'] as const;
type Role = (typeof ROLES)[number];

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The user list, with the counts that make promoting someone an informed
   * decision rather than a guess at a name.
   */
  app.get<{ Querystring: { q?: string } }>('/api/users', async (req) => {
    requireScope(req, 'admin');

    const q = req.query.q?.trim();
    const rows = db
      .prepare(
        `SELECT u.*,
                (SELECT COUNT(*) FROM bugs b WHERE b.reporter_id = u.id) AS reported_count,
                (SELECT COUNT(*) FROM bugs b WHERE b.assignee_id = u.id) AS assigned_count
         FROM users u
         ${q ? 'WHERE u.name LIKE ?' : ''}
         ORDER BY
           CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
           u.name COLLATE NOCASE`,
      )
      .all(...(q ? [`%${q}%`] : [])) as Array<
      UserRow & { reported_count: number; assigned_count: number }
    >;

    return {
      users: rows.map((u) => ({
        ...publicUser(u)!,
        ezmuzeUserId: u.ezmuze_user_id,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
        reportedCount: u.reported_count,
        assignedCount: u.assigned_count,
      })),
    };
  });

  /**
   * Who a bug can be assigned to. Managers need this for the assignee picker
   * but have no business reading the whole user list, so it is its own route.
   */
  app.get('/api/assignable', async (req) => {
    requireScope(req, 'manage');
    const rows = db
      .prepare(
        `SELECT * FROM users WHERE role IN ('manager','admin') ORDER BY name COLLATE NOCASE`,
      )
      .all() as UserRow[];
    return { users: rows.map((u) => publicUser(u)) };
  });

  /** Promote to manager, demote back to user, or hand over admin. */
  app.post<{ Params: { id: string }; Body: { role?: string } }>(
    '/api/users/:id/role',
    async (req) => {
      const actor = requireScope(req, 'admin');
      const role = req.body?.role;
      if (!isRole(role)) throw new HttpError(400, `Role must be one of ${ROLES.join(', ')}`);

      const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(Number(req.params.id)) as
        | UserRow
        | undefined;
      if (!target) throw new HttpError(404, 'No such user');

      if (target.id === actor.user.id && role !== 'admin') {
        throw new HttpError(
          409,
          'You cannot demote yourself — promote another admin first, then have them do it',
        );
      }

      // Never let the last admin go: the instance would have nobody who can
      // manage users, and the bootstrap path only fires on an empty board.
      if (target.role === 'admin' && role !== 'admin') {
        const admins = (
          db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }
        ).n;
        if (admins <= 1) throw new HttpError(409, 'This is the only admin left');
      }

      db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, target.id);
      app.log.info(
        { actor: actor.user.id, target: target.id, role },
        'user role changed',
      );

      return { user: publicUser({ ...target, role }) };
    },
  );

  // ------------------------------------------------------------ API tokens

  app.get('/api/tokens', async (req) => {
    requireScope(req, 'admin');
    const rows = db
      .prepare(
        `SELECT t.id, t.name, t.scopes, t.created_at, t.last_used_at, t.revoked_at,
                u.id AS user_id, u.name AS user_name, u.role AS user_role
         FROM api_tokens t JOIN users u ON u.id = t.user_id
         ORDER BY t.revoked_at IS NOT NULL, t.id`,
      )
      .all() as Array<Record<string, unknown>>;

    return {
      tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        scopes: String(t.scopes).split(','),
        actsAs: { id: t.user_id, name: t.user_name, role: t.user_role },
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
        revokedAt: t.revoked_at,
      })),
    };
  });

  /**
   * Mint a token for a machine caller. The secret is shown once, here, and only
   * its hash is stored — there is no way to read it back later.
   */
  app.post<{
    Body: { name?: string; scopes?: string[]; actAsUserId?: number; botName?: string; botRole?: string };
  }>('/api/tokens', async (req, reply) => {
    requireScope(req, 'admin');
    const body = req.body ?? {};

    const name = (body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Give the token a name so you know what to revoke later');

    const scopes = (body.scopes ?? ['read']).filter((s): s is Scope =>
      (ALL_SCOPES as string[]).includes(s),
    );
    if (!scopes.length) throw new HttpError(400, `scopes must be some of ${ALL_SCOPES.join(', ')}`);

    // Either attach to an existing account, or stand up a bot user to act as.
    let userId: number;
    if (body.actAsUserId !== undefined) {
      const found = db.prepare(`SELECT id FROM users WHERE id = ?`).get(Number(body.actAsUserId)) as
        | { id: number }
        | undefined;
      if (!found) throw new HttpError(404, 'No such user to act as');
      userId = found.id;
    } else {
      const botName = (body.botName ?? name).trim();
      const botRole = isRole(body.botRole) ? body.botRole : 'manager';
      const info = db
        .prepare(`INSERT INTO users (ezmuze_user_id, name, role, is_bot) VALUES (NULL, ?, ?, 1)`)
        .run(botName, botRole);
      userId = Number(info.lastInsertRowid);
    }

    const secret = newToken();
    db.prepare(
      `INSERT INTO api_tokens (name, token_hash, user_id, scopes) VALUES (?, ?, ?, ?)`,
    ).run(name, hashToken(secret), userId, scopes.join(','));

    return reply.code(201).send({
      token: secret,
      note: 'Copy this now — it is stored hashed and cannot be shown again.',
      name,
      scopes,
    });
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    requireScope(req, 'admin');
    const info = db
      .prepare(`UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
      .run(Number(req.params.id));
    if (info.changes === 0) throw new HttpError(404, 'No such active token');
    return { ok: true };
  });
}
