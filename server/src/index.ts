import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import { config, isProd } from './config.js';
import { pruneExpired } from './db.js';
import { COLUMNS, SEVERITIES } from './columns.js';
import { HttpError, resolveActor } from './auth/identity.js';
import { authRoutes } from './routes/auth.js';
import { bugRoutes } from './routes/bugs.js';
import { attachmentRoutes } from './routes/attachments.js';
import { adminRoutes } from './routes/admin.js';

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
  columns: COLUMNS,
  severities: SEVERITIES,
  signInProvider: 'ezmuze central',
}));

app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

await app.register(authRoutes);
await app.register(bugRoutes);
await app.register(attachmentRoutes);
await app.register(adminRoutes);

// ------------------------------------------------------------------ the SPA

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

// --------------------------------------------------------------- background

pruneExpired();
const pruneTimer = setInterval(pruneExpired, 15 * 60 * 1000);
pruneTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} — shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
app.log.info(`ToDont tracker listening on ${config.host}:${config.port} (public: ${config.publicUrl})`);
