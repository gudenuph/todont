import { db } from '../db.js';
import { HttpError } from '../auth/identity.js';
import { slugify } from './board.js';

/**
 * Ticket kinds, their level scales and the environment list — everything that
 * used to be a constant in `columns.ts`, now rows an instance can edit.
 *
 * Same split as the lanes: `key` is permanent and stored on every ticket,
 * everything else is presentation. That is what lets a scale be reworded, or a
 * kind renamed, without touching a single bug.
 */

export interface Level {
  key: string;
  label: string;
  short: string;
  color: string;
}

export interface ItemKind {
  key: string;
  label: string;
  emoji: string;
  article: string;
  hiddenFields: string[];
  labels: Record<string, string>;
  levels: Level[];
}

/**
 * Fields a kind may hide. The set is code — these are real fields on the form —
 * but which of them a kind hides is data.
 */
export const HIDEABLE_FIELDS = [
  'steps',
  'expected',
  'actual',
  'appVersion',
  'stackTrace',
  'environment',
] as const;

/** Wording a kind may override, again code-defined slots with data values. */
export const LABEL_SLOTS = [
  'description',
  'severity',
  'severityShort',
  'titlePlaceholder',
] as const;

let kindCache: ItemKind[] | null = null;
let envCache: string[] | null = null;

export function invalidateCatalog(): void {
  kindCache = null;
  envCache = null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function listKinds(): ItemKind[] {
  if (kindCache) return kindCache;

  const kinds = db
    .prepare(`SELECT * FROM kinds ORDER BY position, id`)
    .all() as Array<{
    id: number;
    key: string;
    label: string;
    emoji: string;
    article: string;
    hidden_fields: string;
    labels: string;
  }>;

  const levels = db
    .prepare(`SELECT * FROM levels ORDER BY kind_id, position, id`)
    .all() as Array<{
    kind_id: number;
    key: string;
    label: string;
    short: string;
    color: string;
  }>;

  kindCache = kinds.map((k) => ({
    key: k.key,
    label: k.label,
    emoji: k.emoji,
    article: k.article,
    hiddenFields: parseJson<string[]>(k.hidden_fields, []),
    labels: parseJson<Record<string, string>>(k.labels, {}),
    levels: levels
      .filter((l) => l.kind_id === k.id)
      .map((l) => ({ key: l.key, label: l.label, short: l.short, color: l.color })),
  }));

  return kindCache;
}

export function listEnvironments(): string[] {
  if (!envCache) {
    envCache = (
      db.prepare(`SELECT label FROM environments ORDER BY position, id`).all() as Array<{
        label: string;
      }>
    ).map((r) => r.label);
  }
  return envCache;
}

export function kindOf(key: string): ItemKind | undefined {
  return listKinds().find((k) => k.key === key);
}

export function isKind(value: unknown): value is string {
  return typeof value === 'string' && listKinds().some((k) => k.key === value);
}

/** What a ticket is when nobody says: the leftmost kind. */
export function defaultKind(): string {
  return listKinds()[0]?.key ?? 'bug';
}

export function levelsFor(kind: string): Level[] {
  return kindOf(kind)?.levels ?? [];
}

export function isLevelOf(kind: string, level: unknown): level is string {
  return typeof level === 'string' && levelsFor(kind).some((l) => l.key === level);
}

/** The middle-ish default: neither "drop everything" nor "barely worth saying". */
export function defaultLevelFor(kind: string): string {
  const levels = levelsFor(kind);
  return levels[Math.min(2, levels.length - 1)]?.key ?? '';
}

/**
 * Carry a level across when a ticket is retyped. Scales share no keys, so
 * position is what survives: the second-most-pressing bug becomes the
 * second-most-pressing request rather than resetting to a default.
 */
export function translateLevel(fromKind: string, toKind: string, level: string): string {
  const from = levelsFor(fromKind);
  const to = levelsFor(toKind);
  const index = from.findIndex((l) => l.key === level);
  if (index < 0) return defaultLevelFor(toKind);
  return to[Math.min(index, to.length - 1)]?.key ?? defaultLevelFor(toKind);
}

// -------------------------------------------------------------------- admin

export function uniqueKindKey(label: string): string {
  const base = slugify(label) || 'kind';
  const taken = new Set(listKinds().map((k) => k.key));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new HttpError(409, 'Could not find a free key for that name');
}

export function uniqueLevelKey(kindId: number, label: string): string {
  const base = slugify(label) || 'level';
  const taken = new Set(
    (db.prepare(`SELECT key FROM levels WHERE kind_id = ?`).all(kindId) as Array<{ key: string }>).map(
      (r) => r.key,
    ),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new HttpError(409, 'Could not find a free key for that level');
}

export function serializeKindAdmin(key: string) {
  const row = db.prepare(`SELECT * FROM kinds WHERE key = ?`).get(key) as
    | { id: number; key: string; position: number }
    | undefined;
  if (!row) throw new HttpError(404, 'No such type');

  const kind = kindOf(key)!;
  const used = db
    .prepare(`SELECT COUNT(*) AS n FROM bugs WHERE kind = ?`)
    .get(key) as { n: number };

  return {
    id: row.id,
    ...kind,
    position: row.position,
    bugCount: used.n,
    levels: kind.levels.map((l) => ({
      ...l,
      bugCount: (
        db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE kind = ? AND severity = ?`).get(key, l.key) as {
          n: number;
        }
      ).n,
    })),
  };
}
