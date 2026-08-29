import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { db, type UserRow } from '../db.js';

export const SESSION_COOKIE = 'todont_session';

/**
 * `versions` is deliberately its own scope rather than part of `manage`: the
 * publishing pipeline needs to register a release and nothing else, and a CI
 * token that could also delete bugs would be far too much authority.
 */
export type Scope = 'read' | 'write' | 'manage' | 'admin' | 'versions';
export const ALL_SCOPES: Scope[] = ['read', 'write', 'manage', 'admin', 'versions'];

export interface Actor {
  user: UserRow;
  /** How they authenticated. */
  via: 'session' | 'token';
  /** For tokens, the granted scopes; for sessions, everything their role allows. */
  scopes: Set<Scope>;
  tokenName?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return `ezb_${randomBytes(24).toString('base64url')}`;
}

/** Scopes a role implies when signed in through the browser. */
function scopesForRole(role: UserRow['role']): Set<Scope> {
  switch (role) {
    case 'admin':
      return new Set<Scope>(['read', 'write', 'manage', 'admin', 'versions']);
    case 'manager':
      return new Set<Scope>(['read', 'write', 'manage', 'versions']);
    default:
      return new Set<Scope>(['read', 'write']);
  }
}

/**
 * Find or create the local user behind an ezmuze central account.
 *
 * Role bootstrap: ids listed in ADMIN_EZMUZE_USER_IDS are always admin. Failing
 * that, if the instance has no admin at all, the first person through the door
 * becomes one — the usual self-hosted bootstrap, and the deploy README says to
 * sign in immediately after standing the site up.
 */
export function upsertEzmuzeUser(ezmuzeUserId: string, name: string): UserRow {
  const id = ezmuzeUserId.toLowerCase();
  const existing = db
    .prepare(`SELECT * FROM users WHERE ezmuze_user_id = ?`)
    .get(id) as UserRow | undefined;

  const configuredAdmin = config.adminEzmuzeUserIds.includes(id);

  if (existing) {
    const role = configuredAdmin && existing.role !== 'admin' ? 'admin' : existing.role;
    db.prepare(
      `UPDATE users SET name = ?, role = ?, last_seen_at = datetime('now') WHERE id = ?`,
    ).run(name, role, existing.id);
    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(existing.id) as UserRow;
  }

  const adminCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }
  ).n;

  const role: UserRow['role'] = configuredAdmin || adminCount === 0 ? 'admin' : 'user';

  const info = db
    .prepare(
      `INSERT INTO users (ezmuze_user_id, name, role, last_seen_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(id, name, role);

  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as UserRow;
}

export function createSession(userId: number, authKey: string | null): string {
  const sid = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (id, user_id, auth_key, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
  ).run(sid, userId, authKey, `+${config.sessionDays} days`);
  return sid;
}

export function destroySession(sid: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
}

export function setSessionCookie(reply: FastifyReply, sid: string): void {
  reply.setCookie(SESSION_COOKIE, sid, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionDays * 24 * 60 * 60,
    signed: true,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function actorFromSession(req: FastifyRequest): Actor | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;

  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .get(unsigned.value) as UserRow | undefined;

  if (!row) return null;
  return { user: row, via: 'session', scopes: scopesForRole(row.role) };
}

/** Did this request present something that was meant to be an API token? */
export function presentedToken(req: FastifyRequest): boolean {
  const header = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() !== '';
  }
  return typeof apiKey === 'string' && apiKey.trim() !== '';
}

function actorFromToken(req: FastifyRequest): Actor | null {
  const header = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];

  let token: string | null = null;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    token = header.slice(7).trim();
  } else if (typeof apiKey === 'string' && apiKey.trim() !== '') {
    token = apiKey.trim();
  }
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT t.id AS token_id, t.name AS token_name, t.scopes AS token_scopes, u.*
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .get(hashToken(token)) as
    | (UserRow & { token_id: number; token_name: string; token_scopes: string })
    | undefined;

  if (!row) {
    // Log the tail, never the token: enough to tell "wrong credential" from
    // "no credential" when someone reports a 401, without storing a secret.
    req.log.warn(
      { tokenSuffix: token.slice(-6) },
      'API token presented but not recognised',
    );
    return null;
  }

  db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(
    row.token_id,
  );

  const granted = row.token_scopes
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));

  // A token can never exceed what its user's role allows.
  const allowed = scopesForRole(row.role);
  const scopes = new Set<Scope>(granted.filter((s) => allowed.has(s)));

  const user: UserRow = {
    id: row.id,
    ezmuze_user_id: row.ezmuze_user_id,
    name: row.name,
    role: row.role,
    is_bot: row.is_bot,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };

  return { user, via: 'token', scopes, tokenName: row.token_name };
}

/** Populates req.actor. Never rejects — the board is public to read. */
export function resolveActor(req: FastifyRequest): void {
  req.actor = actorFromToken(req) ?? actorFromSession(req);
}

// ------------------------------------------------------------- route guards

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireActor(req: FastifyRequest): Actor {
  if (req.actor) return req.actor;

  // Telling a build server to "sign in with your ezmuze account" is useless and
  // sends whoever is debugging it looking in entirely the wrong place.
  if (presentedToken(req)) {
    throw new HttpError(
      401,
      'That API token was not recognised — it may have been revoked, or copied incompletely',
    );
  }

  throw new HttpError(401, 'Sign in with your ezmuze account first');
}

export function requireScope(req: FastifyRequest, scope: Scope): Actor {
  const actor = requireActor(req);
  if (!actor.scopes.has(scope)) {
    throw new HttpError(
      403,
      scope === 'manage'
        ? 'Only managers can do that'
        : scope === 'admin'
          ? 'Only admins can do that'
          : scope === 'versions'
            ? 'That needs a token with the "versions" scope'
            : `Missing "${scope}" permission`,
    );
  }
  return actor;
}

export function publicUser(u: UserRow | null | undefined) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    isBot: u.is_bot === 1,
  };
}
