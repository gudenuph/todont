import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { HttpError } from '../auth/identity.js';
import { beginConnect, pollConnect, validateToken } from '../auth/ezmuze.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createLocalUser,
  createSession,
  destroySession,
  enabledProviders,
  markSeen,
  providerEnabled,
  publicUser,
  requireActor,
  setSessionCookie,
  upsertFederatedUser,
  userByEmail,
} from '../auth/identity.js';
import { config } from '../config.js';
import {
  hashPassword,
  normalizeEmail,
  passwordProblem,
  verifyPassword,
} from '../auth/passwords.js';

/** A handshake the user has 10 minutes to approve. */
const HANDSHAKE_TTL = '+10 minutes';

const MAX_NAME = 60;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** What the sign-in dialog should offer. */
  app.get('/api/auth/providers', async () => ({
    providers: enabledProviders(),
    allowSignup: config.allowSignup && providerEnabled('local'),
  }));

  /**
   * Create an account with an email and a password held here.
   *
   * There is no verification mail, because an instance is not assumed to have
   * anywhere to send it from. The address is an identifier and a way for an
   * admin to recognise a person, not a proven channel — so nothing is ever sent
   * to it and nothing should be trusted because of it.
   */
  app.post<{ Body: { email?: string; password?: string; name?: string } }>(
    '/api/auth/signup',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      if (!providerEnabled('local')) {
        throw new HttpError(404, 'This tracker does not use email sign-in');
      }
      if (!config.allowSignup) {
        throw new HttpError(403, 'This tracker is not open for new accounts');
      }

      const body = req.body ?? {};
      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(400, 'That does not look like an email address');

      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);

      const name = String(body.name ?? '').trim() || email.split('@')[0];
      if (name.length > MAX_NAME) throw new HttpError(400, 'That name is too long');

      if (userByEmail(email)) {
        // Taken addresses are worth saying plainly: the alternative is a
        // "check your email" lie we cannot back up, and the address is
        // discoverable from the board anyway.
        throw new HttpError(409, 'There is already an account with that email — sign in instead');
      }

      const user = createLocalUser(email, name, await hashPassword(body.password as string));
      setSessionCookie(reply, createSession(user.id, null));

      app.log.info({ userId: user.id, role: user.role }, 'local account created');
      return reply.code(201).send({ user: publicUser(user) });
    },
  );

  /**
   * Sign in with an email and password.
   *
   * One message for every failure — wrong address, wrong password, an account
   * that only signs in through a provider — so this cannot be used to find out
   * who has an account. Rate limited because it is the one endpoint worth
   * guessing at.
   */
  app.post<{ Body: { email?: string; password?: string } }>(
    '/api/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      if (!providerEnabled('local')) {
        throw new HttpError(404, 'This tracker does not use email sign-in');
      }

      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;
      const refuse = () => new HttpError(401, 'That email and password do not match an account');

      if (!email || typeof password !== 'string' || !password) throw refuse();

      const user = userByEmail(email);
      if (!user?.password_hash) {
        // Still spend the time hashing, so a missing account is not obviously
        // faster to probe than a wrong password.
        await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
        throw refuse();
      }

      if (!(await verifyPassword(password, user.password_hash))) throw refuse();

      markSeen(user.id);
      setSessionCookie(reply, createSession(user.id, null));

      return { user: publicUser(user) };
    },
  );

  /** Change your own password. Needs the current one, session or not. */
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/auth/password',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req) => {
      const actor = requireActor(req);
      const user = actor.user;

      if (!user.password_hash) {
        throw new HttpError(409, 'This account signs in through a provider, so it has no password');
      }

      const current = req.body?.currentPassword;
      if (typeof current !== 'string' || !(await verifyPassword(current, user.password_hash))) {
        throw new HttpError(403, 'That is not your current password');
      }

      const problem = passwordProblem(req.body?.newPassword);
      if (problem) throw new HttpError(400, problem);

      db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
        await hashPassword(req.body!.newPassword as string),
        user.id,
      );

      // Every other session keeps working; changing a password is not a
      // security event here, and signing yourself out of your phone is rude.
      app.log.info({ userId: user.id }, 'password changed');
      return { ok: true };
    },
  );

  /**
   * Start the app-connect handshake. The browser opens `approvalUrl` in a new
   * tab and then polls; the AuthKey never reaches the page.
   */
  app.post('/api/auth/begin', async (_req, reply) => {
    if (!providerEnabled('ezmuze')) {
      return reply.code(404).send({ error: 'This tracker does not use ezmuze sign-in' });
    }

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

      const user = upsertFederatedUser('ezmuze', auth.userId, auth.name);
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

    const user = upsertFederatedUser('ezmuze', auth.userId, auth.name);
    return { user: publicUser(user), refreshed: true };
  });
}
