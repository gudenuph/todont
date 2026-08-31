/**
 * The lanes a brand new instance starts with. Lanes live in the database and
 * are edited from the admin panel — this is only what gets seeded, once.
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

export const SEED_COLUMNS: BoardColumn[] = [
  { key: 'unconfirmed', label: 'Unconfirmed', color: '#ffc440', intake: true },
  { key: 'confirmed', label: 'Confirmed', color: '#e68c32' },
  { key: 'backlog', label: 'Backlog', color: '#b07cff' },
  { key: 'current-focus', label: 'Current focus', color: '#ff6f9c' },
  // Renamed for readers only — the key is what every bug row stores.
  { key: 'in-progress', label: 'In release queue', color: '#35c7e8' },
  { key: 'in-beta-testing', label: 'In beta testing', color: '#96c8ff' },
  { key: 'shipped', label: 'Shipped', color: '#60e0a0', terminal: true },
  { key: 'on-hold', label: 'On hold', color: '#6e8ca8', terminal: true },
  { key: 'rejected', label: 'Rejected', color: '#c44444', terminal: true },
];


/**
 * Where the bug happened. ezmuze studio ships a browser build (Blazor WASM) and
 * desktop builds, so the browser matters as much as the OS does.
 *
 * The UI offers exactly this list. The API deliberately still accepts free text
 * — ezmuze raises bugs programmatically and knows more about the machine than a
 * picker can express, and a closed enum would reject that.
 */
export const SEED_ENVIRONMENTS = [
  'Web — Chrome',
  'Web — Edge',
  'Web — Firefox',
  'Web — Safari',
  'Windows (desktop)',
  'macOS (desktop)',
  'Linux (desktop)',
  'Other',
] as const;

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
  /**
   * How much this one matters, most-pressing first. A bug has a severity; a
   * feature request has how badly someone wants it — the same slot in the row,
   * because it answers the same question and drives the same colour strip.
   * Position is meaningful: retyping a ticket maps the level across by index.
   */
  levels: Level[];
}

/** One step on a kind's scale. The colour is the strip down the left of a card. */
export interface Level {
  key: string;
  /** The full wording, for the picker: "I can't use it without this". */
  label: string;
  /** A card footer is a few characters wide; the full wording will not fit. */
  short: string;
  color: string;
}

export const SEED_KINDS: ItemKind[] = [
  {
    key: 'bug',
    label: 'Bug',
    emoji: '\u{1F41E}',
    article: 'a bug',
    hiddenFields: [],
    labels: {
      description: 'What happened',
      severity: 'Severity',
      severityShort: 'Severity',
      titlePlaceholder: 'What went wrong, in one line',
    },
    levels: [
      { key: 'critical', label: 'Critical', short: 'Critical', color: '#ff5a5a' },
      { key: 'major', label: 'Major', short: 'Major', color: '#e68c32' },
      { key: 'minor', label: 'Minor', short: 'Minor', color: '#6e8ca8' },
      { key: 'trivial', label: 'Trivial', short: 'Trivial', color: '#4e4e5e' },
    ],
  },
  {
    key: 'feature',
    label: 'Feature request',
    emoji: '\u{1F4A1}',
    article: 'a feature request',
    // Reproduction fields: there is nothing to reproduce.
    hiddenFields: ['steps', 'expected', 'actual', 'appVersion', 'stackTrace'],
    labels: {
      description: 'What you would like',
      severity: 'How much do you want it?',
      // The sidebar has one narrow column; the full question does not fit.
      severityShort: 'Wanted',
      titlePlaceholder: 'What you would like, in one line',
    },
    levels: [
      { key: 'blocking', label: "I can't use it without this", short: 'Blocking', color: '#ff5a5a' },
      { key: 'important', label: 'It would make a big difference', short: 'Big deal', color: '#e68c32' },
      { key: 'want', label: 'Kinda want it', short: 'Kinda want', color: '#6e8ca8' },
      { key: 'idea', label: 'Just an idea', short: 'Idea', color: '#4e4e5e' },
    ],
  },
];
