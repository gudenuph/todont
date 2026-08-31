import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * A whole tracker, on a throwaway database.
 *
 * The database is opened when `db.ts` is first imported, and config is read
 * when `config.ts` is, so the environment has to be set before either — hence
 * the dynamic import. `node --test` gives each test file its own process, so
 * files cannot see each other's data.
 */
export interface Harness {
  app: FastifyInstance;
  dir: string;
  close: () => Promise<void>;
}

export async function makeApp(env: Record<string, string> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'todont-test-'));

  Object.assign(process.env, {
    NODE_ENV: 'production', // avoids the pino-pretty dev transport
    LOG_LEVEL: 'silent',
    DATA_DIR: dir,
    PUBLIC_URL: 'http://test.local',
    COOKIE_SECRET: 'a-test-secret-that-is-long-enough-to-sign-with',
    COOKIE_SECURE: 'false',
    SERVE_WEB: 'false',
    AUTH_PROVIDERS: 'local',
    ALLOW_SIGNUP: 'true',
    ...env,
  });

  const { buildApp } = await import('../app.js');
  const { closeDb } = await import('../db.js');
  // Rate limiting off: a suite signing in a dozen times in a second is not an
  // attack, and leaving it on fails tests for reasons unrelated to what they
  // are checking.
  const app = await buildApp({ rateLimit: false });
  await app.ready();

  return {
    app,
    dir,
    close: async () => {
      await app.close();
      closeDb();
      // A leftover temp directory is not worth failing a green suite over.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS will get to it */
      }
    },
  };
}

/** Create an account and return the session cookie it hands back. */
export async function signUp(
  app: FastifyInstance,
  email: string,
  password = 'a good enough password',
  name?: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password, name },
  });
  if (res.statusCode >= 400) throw new Error(`signup failed: ${res.body}`);

  const cookie = res.cookies.find((c) => c.name === 'todont_session');
  if (!cookie) throw new Error('signup returned no session cookie');
  return cookie.value;
}

/** Promote somebody, as the admin identified by `adminCookie`. */
export async function setRole(
  app: FastifyInstance,
  adminCookie: string,
  userId: number,
  role: 'user' | 'manager' | 'admin',
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/users/${userId}/role`,
    cookies: { todont_session: adminCookie },
    payload: { role },
  });
  if (res.statusCode >= 400) throw new Error(`setRole failed: ${res.body}`);
}

export function body<T = Record<string, unknown>>(res: { body: string }): T {
  return JSON.parse(res.body) as T;
}
