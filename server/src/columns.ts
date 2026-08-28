/**
 * The board. `key` is what goes in bugs.status and never changes; `label` is
 * what people see. Order here is the left-to-right order on the board.
 */
export interface BoardColumn {
  key: string;
  label: string;
  /** Column accent, from the ezmuze studio dark palette (design-guide.md §1). */
  color: string;
  /** Where bugs land when nobody has triaged them yet. */
  intake?: boolean;
  /** Terminal columns are collapsed by default on narrow screens. */
  terminal?: boolean;
}

export const COLUMNS: BoardColumn[] = [
  { key: 'unconfirmed', label: 'Unconfirmed', color: '#ffc440', intake: true },
  { key: 'confirmed', label: 'Confirmed', color: '#e68c32' },
  { key: 'backlog', label: 'Backlog', color: '#b07cff' },
  { key: 'current-focus', label: 'Current focus', color: '#ff6f9c' },
  { key: 'in-progress', label: 'In progress', color: '#35c7e8' },
  { key: 'in-beta-testing', label: 'In beta testing', color: '#96c8ff' },
  { key: 'shipped', label: 'Shipped', color: '#60e0a0', terminal: true },
  { key: 'on-hold', label: 'On hold', color: '#6e8ca8', terminal: true },
  { key: 'rejected', label: 'Rejected', color: '#c44444', terminal: true },
];

export const COLUMN_KEYS = COLUMNS.map((c) => c.key);
export const INTAKE_COLUMN = COLUMNS.find((c) => c.intake)!.key;

export function isColumn(key: unknown): key is string {
  return typeof key === 'string' && COLUMN_KEYS.includes(key);
}

export function columnLabel(key: string): string {
  return COLUMNS.find((c) => c.key === key)?.label ?? key;
}

export const SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}
