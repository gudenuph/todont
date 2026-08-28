import path from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`Missing required env var ${name}`);
    return fallback;
  }
  return v;
}

const dataDir = path.resolve(env('DATA_DIR', './data'));

export const config = {
  port: Number(env('PORT', '4310')),
  host: env('HOST', '127.0.0.1'),

  /** Public origin, used to build absolute URLs (attachments, sign-in return). */
  publicUrl: env('PUBLIC_URL', 'http://localhost:5173').replace(/\/$/, ''),

  dataDir,
  dbPath: path.join(dataDir, 'tracker.db'),
  uploadDir: path.join(dataDir, 'uploads'),

  /** Secret used to sign the session cookie. */
  cookieSecret: env('COOKIE_SECRET', 'dev-insecure-secret-change-me'),
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
  sessionDays: Number(env('SESSION_DAYS', '30')),

  /** ezmuze central. Constants, not settings — see ezmuze-studio docs/services-design.md §2. */
  central: {
    api: 'https://api.ezmuze.co.uk/',
    website: 'https://www.ezmuze.co.uk/',
  },

  /**
   * ezmuze central user ids (GUIDs) that are always admins, comma separated.
   * If this is empty AND no admin exists yet, the first person to sign in is
   * made admin — the standard self-hosted bootstrap. Fix later with:
   *   node server/dist/cli.js promote <ezmuzeUserId> admin
   */
  adminEzmuzeUserIds: env('ADMIN_EZMUZE_USER_IDS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  maxUploadBytes: Number(env('MAX_UPLOAD_BYTES', String(10 * 1024 * 1024))),
  maxUploadsPerBug: Number(env('MAX_UPLOADS_PER_BUG', '10')),

  /** Serve the built web/ SPA from the API process (true in production). */
  serveWeb: env('SERVE_WEB', 'false') === 'true',
  webDist: path.resolve(env('WEB_DIST', '../web/dist')),
} as const;

export const isProd = process.env.NODE_ENV === 'production';
