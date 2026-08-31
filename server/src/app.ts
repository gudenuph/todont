import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { config, isProd } from './config.js';
import { pruneExpired } from './db.js';
import { listEnvironments, listKinds } from './lib/catalog.js';
import { boardSettings, listColumns, serializeColumn } from './lib/board.js';
import { HttpError, resolveActor } from './auth/identity.js';
import { authRoutes } from './routes/auth.js';
import { bugRoutes } from './routes/bugs.js';
import { attachmentRoutes } from './routes/attachments.js';
import { adminRoutes } from './routes/admin.js';
import { boardAdminRoutes } from './routes/board-admin.js';
import { catalogAdminRoutes } from './routes/catalog-admin.js';
import { versionRoutes, listVersions, serializeVersion, defaultVersion } from './routes/versions.js';
import { stackTraceRoutes } from './routes/stacktraces.js';
import { draftRoutes } from './routes/drafts.js';

export interface BuildOptions {
  /**
   * Rate limiting is on in production and off in tests. A suite that signs in
   * a dozen times in a second is not an attack, and leaving it on would make
   * tests fail for a reason that has nothing to do with what they check.
   */
  rateLimit?: boolean;
}

/**
 * Build the server without starting it.
 *
 * Separate from the bootstrap so tests can drive the real app through
 * `app.inject()` — the whole stack, routes, hooks, auth and all — with no port
 * to bind and no process to manage.
 */
export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isProd
      ? { level: process.env.LOG_LEVEL ?? 'info' }
      : { level: 'info', transport: { target: 'pino-pretty' } },
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cookie, { secret: config.cookieSecret });

  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: config.maxUploadsPerBug },
  });

  if (options.rateLimit !== false) {
    await app.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: '1 minute',
      // Machine callers get their own bucket rather than sharing the caller IP's.
      keyGenerator: (req) => {
        const auth = req.headers.authorization ?? req.headers['x-api-key'];
        return typeof auth === 'string' && auth ? `key:${auth.slice(-16)}` : (req.ip ?? 'anon');
      },
    });
  }

  /**
   * Treat an empty JSON body as `{}`. Several endpoints take no body at all
   * (sign out, unmerge), and a client that sets a JSON content-type anyway —
   * which most HTTP libraries do by default on POST — would otherwise get a 400
   * with nothing wrong on its side.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new HttpError(400, 'That request body is not valid JSON');
      done(err, undefined);
    }
  });

  /** Every request knows who is asking; nothing here rejects anonymous readers. */
  app.addHook('onRequest', async (req) => {
    resolveActor(req);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    // Fastify's own errors (bad JSON, upload too large, rate limit) already carry
    // a usable status and message; only 5xx gets swallowed into a generic reply.
    const status = err.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Something went wrong on our side' });
  });

  /** Board shape, so the client never hardcodes the column list. */
  app.get('/api/meta', async () => ({
    // Lanes and the board's name are instance settings now, so this is read from
    // the database rather than baked into the bundle.
    board: boardSettings(),
    columns: listColumns().map(serializeColumn),
    environments: listEnvironments(),
    // Versions come from the database, not a constant: the publishing pipeline
    // adds them, so they change without a deploy.
    versions: listVersions().map(serializeVersion),
    defaultVersion: defaultVersion(),
    // Each kind carries its own scale, wording and hidden fields, so the card,
    // the dialog and the raise menu all read from one place.
    kinds: listKinds(),
  }));

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(bugRoutes);
  await app.register(attachmentRoutes);
  await app.register(adminRoutes);
  await app.register(boardAdminRoutes);
  await app.register(catalogAdminRoutes);
  await app.register(versionRoutes);
  await app.register(stackTraceRoutes);
  await app.register(draftRoutes);

  // ---------------------------------------------------------------- the SPA

  if (config.serveWeb) {
    if (!fs.existsSync(path.join(config.webDist, 'index.html'))) {
      app.log.warn({ dir: config.webDist }, 'SERVE_WEB is on but no built web/dist was found');
    }

    await app.register(fastifyStatic, { root: config.webDist, index: false, wildcard: false });

    // Client-side routing: anything that is not an API call gets the shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'No such endpoint' });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  }

  // ------------------------------------------------------------- background

  pruneExpired();
  const pruneTimer = setInterval(pruneExpired, 15 * 60 * 1000);
  pruneTimer.unref();
  app.addHook('onClose', async () => clearInterval(pruneTimer));

  return app;
}
