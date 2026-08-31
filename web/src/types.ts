export interface BoardColumn {
  key: string;
  label: string;
  color: string;
  intake?: boolean;
  terminal?: boolean;
}

export interface Level {
  key: string;
  label: string;
  /** Card-footer wording; the full label is for pickers. */
  short: string;
  /** Colour of the strip down the left of a card at this level. */
  color: string;
}

export interface ItemKind {
  key: string;
  label: string;
  emoji: string;
  /** "a bug", "a feature request" — for the raise menu. */
  article: string;
  /** Fields this kind hides, because they make no sense for it. */
  hiddenFields: string[];
  /** Kind-specific wording, e.g. how the scale is asked about. */
  labels: Record<string, string>;
  /** This kind's scale, most pressing first. */
  levels: Level[];
}

export interface Version {
  id: number;
  name: string;
  releasedAt: string | null;
  isUnreleased: boolean;
}

export interface BoardSettings {
  name: string;
  tagline: string;
}

export interface AdminColumn {
  id: number;
  key: string;
  label: string;
  color: string;
  position: number;
  intake: boolean;
  terminal: boolean;
  bugCount: number;
}

export interface Meta {
  board: BoardSettings;
  columns: BoardColumn[];
  environments: string[];
  /** Newest release first, with "Unreleased" pinned last. */
  versions: Version[];
  /** The newest actual release — what a new report starts on. */
  defaultVersion: string;
  kinds: ItemKind[];
  signInProvider: string;
}

export interface User {
  id: number;
  name: string;
  role: 'user' | 'manager' | 'admin';
  isBot: boolean;
}

export interface AdminUser extends User {
  ezmuzeUserId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  reportedCount: number;
  assignedCount: number;
}

export interface BugCard {
  id: number;
  title: string;
  severity: string;
  kind: string;
  status: string;
  position: number;
  source: string;
  externalRef: string | null;
  reporter: User | null;
  assignee: User | null;
  /** How many times this crash has been reported. */
  occurrences: number;
  /** Ticket ids this one waits on, and ids waiting on it. */
  blockedBy: number[];
  blocking: number[];
  commentCount: number;
  attachmentCount: number;
  duplicateCount: number;
  mergedIntoId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: number;
  url: string;
  name: string;
  mime: string;
  size: number;
  uploadedBy: User | null;
  createdAt: string;
}

export interface Comment {
  id: number;
  author: User | null;
  body: string;
  createdAt: string;
}

export interface BugEvent {
  id: number;
  actor: User | null;
  type: string;
  detail: string;
  createdAt: string;
}

/** Just enough of a ticket to name it in a list of blockers. */
export interface RelatedTicket {
  id: number;
  title: string;
  status: string;
  kind: string;
  severity: string;
}

export interface BugDetail extends Omit<BugCard, 'blockedBy' | 'blocking'> {
  blockedBy: RelatedTicket[];
  blocking: RelatedTicket[];
  description: string;
  steps: string;
  expected: string;
  actual: string;
  appVersion: string;
  environment: string;
  /** Empty unless you can manage — everyone still sees that one exists. */
  stackTrace: string;
  hasStackTrace: boolean;
  stackFingerprint: string | null;
  attachments: Attachment[];
  comments: Comment[];
  events: BugEvent[];
  duplicates: Array<BugCard & { description: string }>;
}

/** What the app already knew when it sent someone here to report. */
export interface Prefill {
  kind?: string;
  title?: string;
  description?: string;
  steps?: string;
  expected?: string;
  actual?: string;
  severity?: string;
  appVersion?: string;
  environment?: string;
  stackTrace?: string;
}

export interface AuthOptions {
  providers: string[];
  allowSignup: boolean;
}

export interface Session {
  user: User | null;
  /** Your own address and its state — never present on anyone else's. */
  email?: string | null;
  emailVerified?: boolean;
  verificationRequired?: boolean;
  scopes?: string[];
  via?: 'session' | 'token';
}
