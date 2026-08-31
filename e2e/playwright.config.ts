import { defineConfig, devices } from '@playwright/test';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 4399;

// Playwright loads this file as CommonJS, so __dirname rather than import.meta.
const HERE = __dirname;
const WEB_DIST = path.join(HERE, '..', 'web', 'dist');
const SERVER = path.join(HERE, '..', 'server', 'dist', 'index.js');

/**
 * A directory per run, rather than emptying one.
 *
 * This file is evaluated again in every worker process, so deleting here would
 * try to remove a database the server already has open — which Windows refuses
 * outright. A fresh directory each time gives the same clean board with nothing
 * to delete. The id is put in the environment so workers agree on it.
 */
const RUN_ID = process.env.E2E_RUN_ID ?? String(Date.now());
process.env.E2E_RUN_ID = RUN_ID;
const DATA_DIR = path.join(HERE, '.data', RUN_ID);

// Tidy up what earlier runs left, without caring if any of it is still locked.
try {
  for (const old of readdirSync(path.join(HERE, '.data'))) {
    if (old !== RUN_ID) rmSync(path.join(HERE, '.data', old), { recursive: true, force: true });
  }
} catch {
  /* nothing to tidy, or something is still holding it */
}

export default defineConfig({
  testDir: path.join(HERE, 'tests'),
  globalSetup: path.join(HERE, 'global-setup.ts'),
  // One server, one database, one board: these tests share a world on purpose,
  // because that is the thing being tested.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: path.join(HERE, 'test-results'),

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // The built app, served exactly as in production — the same process
    // serving the same bundle, so nothing here is a special arrangement.
    command: `node ${JSON.stringify(SERVER)}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR,
      PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      COOKIE_SECRET: 'end-to-end-test-secret-long-enough-to-sign',
      COOKIE_SECURE: 'false',
      SERVE_WEB: 'true',
      WEB_DIST,
      AUTH_PROVIDERS: 'local,ezmuze',
      ALLOW_SIGNUP: 'true',
    },
  },
});
