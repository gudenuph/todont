import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { beginConnect, pollConnect, validateToken } from '../auth/ezmuze.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  publicUser,
  requireActor,
  setSessionCookie,
  upsertEzmuzeUser,
} from '../auth/identity.js';

/** A handshake the user has 10 minutes to approve. */
const HANDSHAKE_TTL = '+10 minutes';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Start the app-connect handshake. The browser opens `approvalUrl` in a new
   * tab and then polls; the AuthKey never reaches the page.
   */
  app.post('/api/auth/begin', async (_req, reply) => {
    let connect;
    try {
      connect = await beginConnect();
    } catch (err) {
      app.log.error({ err }, 'ezmuze central handshake failed to start');
      return reply.code(502).send({
        error: 'Could not reach ezmuze central. Try again in a moment.',
      });
    }

    db.prepare(
      `INSERT INTO auth_requests (request_id, connection_id, expires_at)
       VALUES (?, ?, datetime('now', ?))`,
    ).run(connect.requestId, connect.connectionId, HANDSHAKE_TTL);

    return {
      requestId: connect.requestId,
      approvalUrl: connect.approvalUrl,
      expiresInSeconds: 600,
    };
  });

  /**
   * One poll of an in-flight handshake. `pending` is the normal answer until
   * the user approves in the other tab.
   */
  app.get<{ Querystring: { requestId?: string } }>(
    '/api/auth/poll',
    { config: { rateLimit: { max: 240, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const requestId = req.query.requestId;
      if (!requestId) return reply.code(400).send({ error: 'requestId is required' });

      const row = db
        .prepare(
          `SELECT * FROM auth_requests
           WHERE request_id = ? AND expires_at > datetime('now')`,
        )
        .get(requestId) as { request_id: string; connection_id: string } | undefined;

      if (!row) {
        return reply.code(410).send({ status: 'expired' });
      }

      let auth;
      try {
        auth = await pollConnect(row.request_id, row.connection_id);
      } catch (err) {
        app.log.warn({ err }, 'poll against ezmuze central failed');
        return { status: 'pending' };
      }

      if (!auth) return { status: 'pending' };

      // Approved. Trade the AuthKey for one of our sessions and drop the handshake.
      db.prepare(`DELETE FROM auth_requests WHERE request_id = ?`).run(row.request_id);

      const user = upsertEzmuzeUser(auth.userId, auth.name);
      const sid = createSession(user.id, auth.authKey);
      setSessionCookie(reply, sid);

      app.log.info(
        { userId: user.id, ezmuze: auth.userId, role: user.role },
        'signed in via ezmuze central',
      );

      return { status: 'approved', user: publicUser(user) };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) destroySession(unsigned.value);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** Who am I? Answers `{ user: null }` for anonymous visitors rather than 401. */
  app.get('/api/me', async (req) => {
    if (!req.actor) return { user: null };
    return {
      user: publicUser(req.actor.user),
      via: req.actor.via,
      scopes: [...req.actor.scopes],
    };
  });

  /**
   * Re-check the signed-in user against ezmuze central. Used to pick up a name
   * change, and to notice a key that central has since revoked.
   */
  app.post('/api/auth/refresh', async (req, reply) => {
    const actor = requireActor(req);
    if (actor.via !== 'session') return { user: publicUser(actor.user), refreshed: false };

    const raw = req.cookies[SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return { user: publicUser(actor.user), refreshed: false };

    const row = db
      .prepare(`SELECT auth_key FROM sessions WHERE id = ?`)
      .get(unsigned.value) as { auth_key: string | null } | undefined;

    if (!row?.auth_key) return { user: publicUser(actor.user), refreshed: false };

    let auth;
    try {
      auth = await validateToken(row.auth_key);
    } catch {
      // Central unreachable: stay signed in on the account we last saw, the way
      // ezmuze studio stays "Offline" rather than signing you out.
      return { user: publicUser(actor.user), refreshed: false, offline: true };
    }

    if (!auth) {
      destroySession(unsigned.value);
      clearSessionCookie(reply);
      return reply.code(401).send({ error: 'ezmuze central no longer recognises this sign-in' });
    }

    const user = upsertEzmuzeUser(auth.userId, auth.name);
    return { user: publicUser(user), refreshed: true };
  });
}
