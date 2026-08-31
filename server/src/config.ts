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

  /**
   * Which ways in this instance offers, in the order the sign-in dialog shows
   * them. `local` is email and password held here; `ezmuze` is the ezmuze
   * central handshake. An instance that lists neither cannot be signed into,
   * so an empty value falls back to local.
   */
  authProviders: (env('AUTH_PROVIDERS', 'local') || 'local')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** Whether strangers may create their own account. */
  allowSignup: env('ALLOW_SIGNUP', 'true') !== 'false',

  /** Email addresses that are always admin, comma separated. */
  adminEmails: env('ADMIN_EMAILS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /**
   * Outbound SMTP. Optional: with no host the tracker behaves exactly as it did
   * before and verification links go to the log instead.
   *
   * Gmail wants smtp.gmail.com:465, the full address as the user, and an
   * **app password** — a normal account password is refused when 2FA is on,
   * which it is by default.
   */
  smtp: {
    host: env('SMTP_HOST', ''),
    port: Number(env('SMTP_PORT', '465')),
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    secure: env('SMTP_SECURE', '') === '' ? undefined : env('SMTP_SECURE', '') === 'true',
    from: env('MAIL_FROM', ''),
    /**
     * Accept a certificate that does not verify. Only for an internal relay
     * with a self-signed certificate on a network you trust — the failure it
     * papers over ("certificate has expired", "self signed certificate") is
     * otherwise a very cryptic dead end for a self-hoster.
     */
    allowInsecureTls: env('SMTP_ALLOW_INSECURE_TLS', 'false') === 'true',
  },

  /**
   * Whether an unverified local account may write. False keeps an instance
   * usable with no mail server at all — people are nudged, not blocked.
   */
  requireVerifiedEmail: env('REQUIRE_VERIFIED_EMAIL', 'false') === 'true',

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

  /** 50MB: screenshots are tiny, but a short screen recording is not. */
  maxUploadBytes: Number(env('MAX_UPLOAD_BYTES', String(50 * 1024 * 1024))),
  maxUploadsPerBug: Number(env('MAX_UPLOADS_PER_BUG', '10')),

  /** Serve the built web/ SPA from the API process (true in production). */
  serveWeb: env('SERVE_WEB', 'false') === 'true',
  webDist: path.resolve(env('WEB_DIST', '../web/dist')),
} as const;

export const isProd = process.env.NODE_ENV === 'production';
