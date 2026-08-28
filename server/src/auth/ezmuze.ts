import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * ezmuze central's app-connection handshake, as ezmuze studio performs it
 * (ezmuze-studio: docs/services-design.md §2.1, EzmuzeCentralService.Waves.cs).
 *
 * It has to run server-side: api.ezmuze.co.uk sends no CORS headers, so the
 * browser cannot call it directly. That is fine — it also keeps the AuthKey
 * out of the page entirely, since we exchange it for our own session cookie.
 *
 *   1. POST /Auth/AppConnectRequest  {RequestId, MachineName, OS} -> connectionId
 *   2. user approves at www.ezmuze.co.uk/appconnection/{RequestId}
 *   3. GET  /Auth/AppLogIn?requestId&connectionId&dummy -> AuthReturn once approved
 *   4. GET  /Auth?authToken=...  validates the key and re-reads the account
 */

export interface AuthReturn {
  userId: string;
  name: string;
  authKey: string;
}

const TIMEOUT_MS = 15_000;

async function centralFetch(url: string, init?: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Case-insensitive read: central returns camelCase, legacy source uses PascalCase. */
function pick(obj: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : obj[found];
}

function toAuthReturn(body: unknown): AuthReturn | null {
  if (typeof body !== 'object' || body === null) return null;
  const o = body as Record<string, unknown>;
  const userId = pick(o, 'userId');
  const name = pick(o, 'name');
  const authKey = pick(o, 'authKey');
  if (typeof authKey !== 'string' || authKey.trim() === '') return null;
  if (typeof userId !== 'string' || userId.trim() === '') return null;
  return {
    userId: userId.toLowerCase(),
    name: typeof name === 'string' && name.trim() !== '' ? name : 'ezmuze user',
    authKey,
  };
}

/** Step 1. Returns { requestId, connectionId, approvalUrl }. */
export async function beginConnect(): Promise<{
  requestId: string;
  connectionId: string;
  approvalUrl: string;
}> {
  const requestId = randomUUID();
  const res = await centralFetch(`${config.central.api}Auth/AppConnectRequest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      RequestId: requestId,
      MachineName: 'bugs.ezmuze.studio',
      OS: 'web',
    }),
  });

  if (!res.ok) {
    throw new Error(`ezmuze central rejected the connect request (HTTP ${res.status})`);
  }

  // The endpoint answers with a bare JSON string: "e4f97cd7-...".
  const raw = (await res.text()).trim();
  let connectionId: string;
  try {
    const parsed: unknown = JSON.parse(raw);
    connectionId = typeof parsed === 'string' ? parsed : raw;
  } catch {
    connectionId = raw.replace(/^"|"$/g, '');
  }

  if (!connectionId) throw new Error('ezmuze central returned no connection id');

  return {
    requestId,
    connectionId,
    approvalUrl: `${config.central.website}appconnection/${requestId}`,
  };
}

/**
 * Step 3, one poll. Returns the AuthReturn once the user has approved and null
 * while still waiting — before approval the endpoint answers with something
 * that is not an AuthReturn, which is the normal waiting state, not a failure.
 *
 * `dummy` is a legacy cache-buster; whatever sits in front of this API caches
 * the response without it.
 */
export async function pollConnect(
  requestId: string,
  connectionId: string,
): Promise<AuthReturn | null> {
  const nonce = randomUUID().replace(/-/g, '');
  const url =
    `${config.central.api}Auth/AppLogIn` +
    `?requestId=${encodeURIComponent(requestId)}` +
    `&connectionId=${encodeURIComponent(connectionId)}` +
    `&dummy=${nonce}`;

  const res = await centralFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;

  const body = (await res.text()).trim();
  if (!body) return null;

  try {
    return toAuthReturn(JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Step 4. Validates an AuthKey and re-reads the account behind it.
 * Throws only on a network failure; returns null when central rejects the key.
 */
export async function validateToken(authKey: string): Promise<AuthReturn | null> {
  const url = `${config.central.api}Auth?authToken=${encodeURIComponent(authKey)}`;
  const res = await centralFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;

  const body = (await res.text()).trim();
  if (!body) return null;

  try {
    const auth = toAuthReturn(JSON.parse(body));
    // /Auth echoes the key back; keep the one we already hold if it does not.
    return auth ? { ...auth, authKey: auth.authKey || authKey } : null;
  } catch {
    return null;
  }
}
