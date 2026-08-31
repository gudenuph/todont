import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { SEED_COLUMNS, SEED_ENVIRONMENTS, SEED_KINDS } from './columns.js';
import { isSealed, seal } from './lib/secretbox.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ezmuze_user_id    TEXT UNIQUE,           -- null for bots / machine accounts
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'user'
                      CHECK (role IN ('user','manager','admin')),
  is_bot            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at      TEXT
);

-- How a person proves who they are. One row per login method, so an account
-- can gain a second one later without the others knowing.
CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,          -- 'local' | 'ezmuze' | ...
  subject     TEXT NOT NULL,          -- the email, the central user id, ...
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- One-shot links sent by email. Hashed, like API tokens: a leaked backup or
-- log line should not hand somebody an account.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,          -- 'verify' for now; 'reset' fits here too
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_key      TEXT,                       -- ezmuze central AuthKey, for revalidation
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- The app-connect handshake, in flight. Rows are short lived.
CREATE TABLE IF NOT EXISTS auth_requests (
  request_id     TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','expired')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bugs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  steps          TEXT NOT NULL DEFAULT '',
  expected       TEXT NOT NULL DEFAULT '',
  actual         TEXT NOT NULL DEFAULT '',
  severity       TEXT NOT NULL DEFAULT 'minor',
  kind           TEXT NOT NULL DEFAULT 'bug',   -- fallback; inserts name it
  stack_trace    TEXT NOT NULL DEFAULT '',   -- stored already normalised
  stack_fingerprint TEXT,                    -- sha256 of the normalised trace
  occurrences    INTEGER NOT NULL DEFAULT 1, -- how many times it has been hit
  app_version    TEXT NOT NULL DEFAULT '',
  environment    TEXT NOT NULL DEFAULT '',
  -- A fallback only: every insert names its column explicitly, and which lane
  -- is the intake one is a setting now, not a constant.
  status         TEXT NOT NULL DEFAULT 'unconfirmed',
  position       REAL NOT NULL DEFAULT 0,
  reporter_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source         TEXT NOT NULL DEFAULT 'web',   -- web | api
  external_ref   TEXT UNIQUE,                   -- caller's own id, for idempotent raises
  merged_into_id INTEGER REFERENCES bugs(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bugs_status ON bugs(status, position);
CREATE INDEX IF NOT EXISTS idx_bugs_merged ON bugs(merged_into_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id        INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,        -- on-disk name, generated
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_bug ON attachments(bug_id);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id      INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_bug ON comments(bug_id, id);

-- Append-only activity log, shown on the bug and used as the audit trail.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_id      INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_bug ON events(bug_id, id);

-- The board's lanes. These used to be a constant in the source; they are rows
-- so an instance can shape its own workflow without a deploy.
CREATE TABLE IF NOT EXISTS columns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL UNIQUE,   -- permanent; bugs.status holds this
  label        TEXT NOT NULL,          -- display only, rename freely
  color        TEXT NOT NULL,
  position     INTEGER NOT NULL,
  is_intake    INTEGER NOT NULL DEFAULT 0,
  is_terminal  INTEGER NOT NULL DEFAULT 0
);

-- Where a bug happened. Free text on the ticket, so removing one never
-- rewrites history; this is only what the picker offers.
CREATE TABLE IF NOT EXISTS environments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  label     TEXT NOT NULL UNIQUE,
  position  INTEGER NOT NULL
);

-- What kind of thing a ticket is: a bug, a feature request, whatever an
-- instance needs. The key is permanent and held by every ticket; the rest is
-- presentation and can be edited freely.
CREATE TABLE IF NOT EXISTS kinds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  key            TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL,
  emoji          TEXT NOT NULL,
  article        TEXT NOT NULL,   -- "a bug", for the raise menu
  hidden_fields  TEXT NOT NULL DEFAULT '[]',  -- JSON array of field names
  labels         TEXT NOT NULL DEFAULT '{}',  -- JSON of wording overrides
  position       INTEGER NOT NULL
);

-- How much a ticket of a given kind matters. Order is meaningful: retyping a
-- ticket carries its level across by position.
CREATE TABLE IF NOT EXISTS levels (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind_id   INTEGER NOT NULL REFERENCES kinds(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  label     TEXT NOT NULL,
  short     TEXT NOT NULL,
  color     TEXT NOT NULL,
  position  INTEGER NOT NULL,
  UNIQUE (kind_id, key)
);

-- Instance settings: board name, tagline. Key/value because there are few.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- "This cannot start until that is done." Many-to-many: a ticket can wait on
-- several things and hold up several others. Rows die with either ticket.
CREATE TABLE IF NOT EXISTS blocks (
  blocked_id  INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  blocker_id  INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocked_id, blocker_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);

-- Shipped versions, registered by the ezmuze publishing pipeline so reporters
-- pick their build instead of typing it. Bugs keep the version as plain text,
-- not a foreign key, so removing a version never rewrites history.
CREATE TABLE IF NOT EXISTS versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  released_at    TEXT,                        -- null for the unreleased entry
  is_unreleased  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versions_order ON versions(is_unreleased, released_at DESC);

-- A prefilled report the app hands to the browser. Holds only what the app
-- already knows; nothing here becomes a bug until a signed-in person submits
-- it, which is why creating one needs no credential.
CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes      TEXT NOT NULL DEFAULT 'read',   -- csv of read|write|manage
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at  TEXT
);
`);

/**
 * Additive migrations for databases that already exist — `CREATE TABLE IF NOT
 * EXISTS` above only shapes a fresh one, so a column added later never reaches
 * a deployed instance without this.
 *
 * Deliberately no CHECK constraint on the added columns: SQLite cannot always
 * attach one in ALTER TABLE, and a constraint that exists on new databases but
 * not on migrated ones is worse than validating in one place in the API.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing('bugs', 'kind', `TEXT NOT NULL DEFAULT 'bug'`);
addColumnIfMissing('users', 'email', `TEXT`);
addColumnIfMissing('users', 'password_hash', `TEXT`);
addColumnIfMissing('users', 'email_verified_at', `TEXT`);

/**
 * Accounts that existed before verification did are treated as verified.
 * Introducing a check should never retroactively lock out somebody who signed
 * up when there was nothing to comply with.
 */
db.prepare(
  `UPDATE users SET email_verified_at = datetime('now')
   WHERE email IS NOT NULL AND email_verified_at IS NULL AND password_hash IS NOT NULL`,
).run();

// Emails identify local accounts, but bots and federated users have none, so
// the constraint has to skip nulls — which a plain UNIQUE column would not.
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`,
);

/**
 * Accounts that predate the identities table were all ezmuze central sign-ins.
 * Move them across so login has one mechanism rather than two.
 */
db.prepare(
  `INSERT OR IGNORE INTO identities (provider, subject, user_id)
   SELECT 'ezmuze', ezmuze_user_id, id FROM users WHERE ezmuze_user_id IS NOT NULL`,
).run();
/**
 * Seal any ezmuze AuthKey that predates encryption.
 *
 * These were stored in the clear when the database never left the machine.
 * Backups can now be emailed or pushed to a bucket, so a plaintext credential
 * for somebody's account on another service travels with them. Sealing in
 * place costs nobody their session.
 */
{
  const plain = db
    .prepare(`SELECT id, auth_key FROM sessions WHERE auth_key IS NOT NULL`)
    .all() as Array<{ id: string; auth_key: string }>;

  const stale = plain.filter((row) => !isSealed(row.auth_key));
  if (stale.length) {
    const update = db.prepare(`UPDATE sessions SET auth_key = ? WHERE id = ?`);
    db.transaction(() => {
      for (const row of stale) update.run(seal(row.auth_key), row.id);
    })();
  }
}

addColumnIfMissing('bugs', 'stack_trace', `TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('bugs', 'stack_fingerprint', `TEXT`);
addColumnIfMissing('bugs', 'occurrences', `INTEGER NOT NULL DEFAULT 1`);

// Not unique: a fingerprint can legitimately appear on a bug and on duplicates
// merged into it, and the lookup resolves to the one still on the board.
db.exec(`CREATE INDEX IF NOT EXISTS idx_bugs_fingerprint ON bugs(stack_fingerprint)`);

/** Seeded once, like the lanes, and edited from the admin panel thereafter. */
if ((db.prepare(`SELECT COUNT(*) AS n FROM environments`).get() as { n: number }).n === 0) {
  const insert = db.prepare(`INSERT INTO environments (label, position) VALUES (?, ?)`);
  SEED_ENVIRONMENTS.forEach((label, i) => insert.run(label, (i + 1) * 10));
}

if ((db.prepare(`SELECT COUNT(*) AS n FROM kinds`).get() as { n: number }).n === 0) {
  const insertKind = db.prepare(
    `INSERT INTO kinds (key, label, emoji, article, hidden_fields, labels, position)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLevel = db.prepare(
    `INSERT INTO levels (kind_id, key, label, short, color, position) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  SEED_KINDS.forEach((k, i) => {
    const info = insertKind.run(
      k.key,
      k.label,
      k.emoji,
      k.article,
      JSON.stringify(k.hiddenFields),
      JSON.stringify(k.labels),
      (i + 1) * 10,
    );
    k.levels.forEach((l, j) =>
      insertLevel.run(Number(info.lastInsertRowid), l.key, l.label, l.short, l.color, (j + 1) * 10),
    );
  });
}

/**
 * Seed the lanes on a brand new database only. An existing instance keeps
 * whatever its admins have made of them.
 */
const columnCount = (db.prepare(`SELECT COUNT(*) AS n FROM columns`).get() as { n: number }).n;
if (columnCount === 0) {
  const insert = db.prepare(
    `INSERT INTO columns (key, label, color, position, is_intake, is_terminal)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  SEED_COLUMNS.forEach((c, i) => {
    insert.run(c.key, c.label, c.color, (i + 1) * 10, c.intake ? 1 : 0, c.terminal ? 1 : 0);
  });
}

/**
 * Someone reporting against a build that is not out yet still needs something
 * to pick, so this one is seeded rather than published. It always sorts last.
 */
export const UNRELEASED_VERSION = 'Unreleased';

db.prepare(
  `INSERT OR IGNORE INTO versions (name, released_at, is_unreleased) VALUES (?, NULL, 1)`,
).run(UNRELEASED_VERSION);

/**
 * Release the database file.
 *
 * Only tests need this: the process exiting is enough in production, but
 * Windows will not delete a file that is still open, so a temporary database
 * has to be closed before it can be cleaned up.
 */
export function closeDb(): void {
  if (db.open) db.close();
}

/** Clear out handshakes and sessions nobody finished. */
export function pruneExpired(): void {
  db.prepare(`DELETE FROM auth_requests WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM drafts WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM email_tokens WHERE expires_at < datetime('now')`).run();
}

export interface UserRow {
  id: number;
  /** Kept for the CLI and ADMIN_EZMUZE_USER_IDS; `identities` is authoritative. */
  ezmuze_user_id: string | null;
  email: string | null;
  password_hash: string | null;
  email_verified_at: string | null;
  name: string;
  role: 'user' | 'manager' | 'admin';
  is_bot: number;
  created_at: string;
  last_seen_at: string | null;
}

export interface BugRow {
  id: number;
  title: string;
  description: string;
  steps: string;
  expected: string;
  actual: string;
  severity: string;
  kind: string;
  stack_trace: string;
  stack_fingerprint: string | null;
  occurrences: number;
  app_version: string;
  environment: string;
  status: string;
  position: number;
  reporter_id: number | null;
  assignee_id: number | null;
  source: string;
  external_ref: string | null;
  merged_into_id: number | null;
  created_at: string;
  updated_at: string;
}

export function logEvent(
  bugId: number,
  actorId: number | null,
  type: string,
  detail = '',
): void {
  db.prepare(
    `INSERT INTO events (bug_id, actor_id, type, detail) VALUES (?, ?, ?, ?)`,
  ).run(bugId, actorId, type, detail);
}

