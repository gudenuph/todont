import { request, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ADMIN = { email: 'boss@example.test', password: 'a good enough password', name: 'Boss' };
export const PLAIN = { email: 'plain@example.test', password: 'a good enough password', name: 'Plain' };

/**
 * Sign both people in once, for the whole run.
 *
 * Doing it per test hits the login rate limit, which is a real protection worth
 * keeping switched on — so the tests work the way a person does, signing in
 * once and keeping the session, rather than turning the protection off to suit
 * themselves.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0].use.baseURL!;
  const stateDir = path.join(__dirname, '.data', process.env.E2E_RUN_ID ?? 'state');
  mkdirSync(stateDir, { recursive: true });

  const ctx = await request.newContext({ baseURL });

  // globalSetup can start before the web server has finished booting.
  for (let i = 0; i < 60; i++) {
    try {
      if ((await ctx.get('/api/health')).ok()) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  for (const [who, file] of [
    [ADMIN, 'admin.json'],
    [PLAIN, 'plain.json'],
  ] as const) {
    const fresh = await request.newContext({ baseURL });

    let res = await fresh.post('/api/auth/signup', { data: who });
    if (!res.ok()) {
      res = await fresh.post('/api/auth/login', {
        data: { email: who.email, password: who.password },
      });
    }
    if (!res.ok()) throw new Error(`could not sign in ${who.email}: ${await res.text()}`);

    writeFileSync(path.join(stateDir, file), JSON.stringify(await fresh.storageState()));
    await fresh.dispose();
  }

  await ctx.dispose();
  process.env.E2E_STATE_DIR = stateDir;
}
