export interface BoardColumn {
  key: string;
  label: string;
  color: string;
  intake?: boolean;
  terminal?: boolean;
}

export interface Meta {
  columns: BoardColumn[];
  severities: string[];
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
  status: string;
  position: number;
  source: string;
  externalRef: string | null;
  reporter: User | null;
  assignee: User | null;
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

export interface BugDetail extends BugCard {
  description: string;
  steps: string;
  expected: string;
  actual: string;
  appVersion: string;
  environment: string;
  attachments: Attachment[];
  comments: Comment[];
  events: BugEvent[];
  duplicates: Array<BugCard & { description: string }>;
}

export interface Session {
  user: User | null;
  scopes?: string[];
  via?: 'session' | 'token';
}
