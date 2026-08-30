import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { DEFAULT_KIND, INTAKE_COLUMN } from './columns.js';

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
  kind           TEXT NOT NULL DEFAULT '${DEFAULT_KIND}',  -- bug | feature
  stack_trace    TEXT NOT NULL DEFAULT '',   -- stored already normalised
  stack_fingerprint TEXT,                    -- sha256 of the normalised trace
  occurrences    INTEGER NOT NULL DEFAULT 1, -- how many times it has been hit
  app_version    TEXT NOT NULL DEFAULT '',
  environment    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT '${INTAKE_COLUMN}',
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

addColumnIfMissing('bugs', 'kind', `TEXT NOT NULL DEFAULT '${DEFAULT_KIND}'`);
addColumnIfMissing('bugs', 'stack_trace', `TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('bugs', 'stack_fingerprint', `TEXT`);
addColumnIfMissing('bugs', 'occurrences', `INTEGER NOT NULL DEFAULT 1`);

// Not unique: a fingerprint can legitimately appear on a bug and on duplicates
// merged into it, and the lookup resolves to the one still on the board.
db.exec(`CREATE INDEX IF NOT EXISTS idx_bugs_fingerprint ON bugs(stack_fingerprint)`);

/**
 * Someone reporting against a build that is not out yet still needs something
 * to pick, so this one is seeded rather than published. It always sorts last.
 */
export const UNRELEASED_VERSION = 'Unreleased';

db.prepare(
  `INSERT OR IGNORE INTO versions (name, released_at, is_unreleased) VALUES (?, NULL, 1)`,
).run(UNRELEASED_VERSION);

/** Clear out handshakes and sessions nobody finished. */
export function pruneExpired(): void {
  db.prepare(`DELETE FROM auth_requests WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM drafts WHERE expires_at < datetime('now')`).run();
}

export interface UserRow {
  id: number;
  ezmuze_user_id: string | null;
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

