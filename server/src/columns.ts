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

/**
 * Where the bug happened. ezmuze studio ships a browser build (Blazor WASM) and
 * desktop builds, so the browser matters as much as the OS does.
 *
 * The UI offers exactly this list. The API deliberately still accepts free text
 * — ezmuze raises bugs programmatically and knows more about the machine than a
 * picker can express, and a closed enum would reject that.
 */
export const ENVIRONMENTS = [
  'Web — Chrome',
  'Web — Edge',
  'Web — Firefox',
  'Web — Safari',
  'Windows (desktop)',
  'macOS (desktop)',
  'Linux (desktop)',
  'Other',
] as const;

/**
 * What kind of thing a ticket is. A feature request is a bug row with this flag
 * — same board, same columns, same triage — because the workflow really is the
 * same and a second table would only duplicate it.
 *
 * The emoji is served rather than hardcoded in the client so the card, the
 * dialog and the raise menu cannot drift apart.
 */
export interface ItemKind {
  key: string;
  label: string;
  emoji: string;
  /** For the raise menu: "Raise a bug", "Raise a feature request". */
  article: string;
  /** Fields that make no sense for this kind and are hidden in the UI. */
  hiddenFields: string[];
  /** Kind-specific wording for the fields that are shown. */
  labels: Record<string, string>;
}

export const KINDS: ItemKind[] = [
  {
    key: 'bug',
    label: 'Bug',
    emoji: '\u{1F41E}',
    article: 'a bug',
    hiddenFields: [],
    labels: { description: 'What happened', severity: 'Severity' },
  },
  {
    key: 'feature',
    label: 'Feature request',
    emoji: '\u{1F4A1}',
    article: 'a feature request',
    // Reproduction fields: there is nothing to reproduce.
    hiddenFields: ['steps', 'expected', 'actual', 'appVersion'],
    labels: { description: 'What you would like', severity: 'Priority' },
  },
];

export const KIND_KEYS = KINDS.map((k) => k.key);
export const DEFAULT_KIND = 'bug';

export function isKind(value: unknown): value is string {
  return typeof value === 'string' && KIND_KEYS.includes(value);
}
