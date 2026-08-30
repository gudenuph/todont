import { db } from '../db.js';
import { HttpError } from '../auth/identity.js';

/**
 * The board's shape, which used to be a constant in the source.
 *
 * `key` is what every bug row stores and never changes once created; `label` is
 * what people see and can be renamed freely. That split is why "In progress"
 * could become "In release queue" without touching a single ticket, and it is
 * worth keeping now that anyone can rename a lane from the admin panel.
 */
export interface ColumnRow {
  id: number;
  key: string;
  label: string;
  color: string;
  position: number;
  is_intake: number;
  is_terminal: number;
}

/**
 * Columns are read on nearly every request — validation, the board, the meta —
 * and change perhaps a few times in an instance's life, so they are held in
 * memory and dropped on write.
 */
let cache: ColumnRow[] | null = null;

export function invalidateColumns(): void {
  cache = null;
}

export function listColumns(): ColumnRow[] {
  if (!cache) {
    cache = db
      .prepare(`SELECT * FROM columns ORDER BY position, id`)
      .all() as ColumnRow[];
  }
  return cache;
}

export function serializeColumn(c: ColumnRow) {
  return {
    key: c.key,
    label: c.label,
    color: c.color,
    ...(c.is_intake ? { intake: true } : {}),
    ...(c.is_terminal ? { terminal: true } : {}),
  };
}

/** Admin view: ids and positions, which the public board has no use for. */
export function serializeColumnAdmin(c: ColumnRow) {
  const counts = db
    .prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status = ? AND merged_into_id IS NULL`)
    .get(c.key) as { n: number };
  return {
    id: c.id,
    key: c.key,
    label: c.label,
    color: c.color,
    position: c.position,
    intake: c.is_intake === 1,
    terminal: c.is_terminal === 1,
    bugCount: counts.n,
  };
}

export function isColumn(key: unknown): key is string {
  return typeof key === 'string' && listColumns().some((c) => c.key === key);
}

export function columnByKey(key: string): ColumnRow | undefined {
  return listColumns().find((c) => c.key === key);
}

export function columnLabel(key: string): string {
  return columnByKey(key)?.label ?? key;
}

/**
 * Where new reports land. There is always exactly one — the admin routes
 * enforce it — but fall back to the leftmost lane rather than throwing, so a
 * hand-edited database cannot stop the tracker accepting bugs.
 */
export function intakeColumn(): string {
  const columns = listColumns();
  return (columns.find((c) => c.is_intake === 1) ?? columns[0])?.key ?? 'unconfirmed';
}

/**
 * A url-safe key from a human label. Keys are permanent, so this runs once when
 * a lane is created and never again — renaming "Triage" to "Needs triage"
 * leaves the key as `triage`, which is exactly what keeps existing tickets in
 * place.
 */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function uniqueColumnKey(label: string): string {
  const base = slugify(label) || 'lane';
  const taken = new Set(listColumns().map((c) => c.key));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new HttpError(409, 'Could not find a free key for that name');
}

// ------------------------------------------------------------------ settings

/** Free-form instance settings. Small enough that a key/value table is right. */
export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export interface BoardSettings {
  name: string;
  tagline: string;
}

export function boardSettings(): BoardSettings {
  return {
    name: getSetting('board.name', 'ToDont'),
    tagline: getSetting('board.tagline', "what's broken, and who's on it"),
  };
}
