import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { INTAKE_COLUMN } from './columns.js';

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

/** Clear out handshakes and sessions nobody finished. */
export function pruneExpired(): void {
  db.prepare(`DELETE FROM auth_requests WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
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

