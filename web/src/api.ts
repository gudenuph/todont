import type {
  AdminColumn,
  AdminEnvironment,
  AdminKind,
  AuthOptions,
  AdminUser,
  BoardSettings,
  BugCard,
  BugDetail,
  Meta,
  Prefill,
  Session,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one. A content-type with an empty
  // body is a 400 — which is every bodyless POST here: sign in, sign out,
  // unmerge. FormData sets its own type, boundary included.
  const isJsonBody = init?.body !== undefined && !(init.body instanceof FormData);

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(isJsonBody ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return body as T;
}

const json = (data: unknown) => JSON.stringify(data);

export const api = {
  meta: () => call<Meta>('/api/meta'),

  draft: (id: string) =>
    call<{ draft: Prefill; knownBug: BugCard | null }>(`/api/drafts/${encodeURIComponent(id)}`),
  me: () => call<Session>('/api/me'),

  authOptions: () => call<AuthOptions>('/api/auth/providers'),

  signup: (data: { email: string; password: string; name?: string }) =>
    call<{
      user: User;
      verification: { sent: boolean; required: boolean; mailEnabled: boolean };
    }>('/api/auth/signup', { method: 'POST', body: json(data) }),

  login: (data: { email: string; password: string }) =>
    call<{ user: User }>('/api/auth/login', { method: 'POST', body: json(data) }),

  forgotPassword: (email: string) =>
    call<{ ok: true; message: string }>('/api/auth/forgot', {
      method: 'POST',
      body: json({ email }),
    }),

  resetPassword: (token: string, newPassword: string) =>
    call<{ ok: true; user: User | null }>('/api/auth/reset', {
      method: 'POST',
      body: json({ token, newPassword }),
    }),

  verifyEmail: (token: string) =>
    call<{ ok: true; user: User | null }>('/api/auth/verify', {
      method: 'POST',
      body: json({ token }),
    }),

  resendVerification: () =>
    call<{ ok: true; sent?: boolean; alreadyVerified?: boolean; mailEnabled?: boolean }>(
      '/api/auth/resend-verification',
      { method: 'POST' },
    ),

  changePassword: (currentPassword: string, newPassword: string) =>
    call<{ ok: true }>('/api/auth/password', {
      method: 'POST',
      body: json({ currentPassword, newPassword }),
    }),

  beginSignIn: () =>
    call<{ requestId: string; approvalUrl: string; expiresInSeconds: number }>(
      '/api/auth/begin',
      { method: 'POST' },
    ),
  pollSignIn: (requestId: string) =>
    call<{ status: 'pending' | 'approved' | 'expired'; user?: User }>(
      `/api/auth/poll?requestId=${encodeURIComponent(requestId)}`,
    ),
  signOut: () => call<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  bugs: (params: { q?: string; status?: string; kind?: string; mine?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.status) qs.set('status', params.status);
    if (params.kind) qs.set('kind', params.kind);
    if (params.mine) qs.set('mine', 'true');
    const suffix = qs.toString() ? `?${qs}` : '';
    return call<{ bugs: BugCard[] }>(`/api/bugs${suffix}`);
  },

  bug: (id: number) => call<{ bug: BugDetail }>(`/api/bugs/${id}`),

  createBug: (data: Record<string, unknown>) =>
    call<{ bug: BugDetail }>('/api/bugs', { method: 'POST', body: json(data) }),

  updateBug: (id: number, data: Record<string, unknown>) =>
    call<{ bug: BugDetail }>(`/api/bugs/${id}`, { method: 'PATCH', body: json(data) }),

  moveBug: (id: number, status: string, index?: number) =>
    call<{ bug: BugDetail }>(`/api/bugs/${id}/move`, {
      method: 'POST',
      body: json({ status, index }),
    }),

  mergeBug: (id: number, intoId: number) =>
    call<{ bug: BugDetail; into: BugDetail }>(`/api/bugs/${id}/merge`, {
      method: 'POST',
      body: json({ intoId }),
    }),

  unmergeBug: (id: number) =>
    call<{ bug: BugDetail }>(`/api/bugs/${id}/unmerge`, { method: 'POST' }),

  assignBug: (id: number, userId: number | null) =>
    call<{ bug: BugDetail }>(`/api/bugs/${id}/assign`, { method: 'POST', body: json({ userId }) }),

  deleteBug: (id: number) =>
    call<{ ok: true; deleted: number; released: number[] }>(`/api/bugs/${id}`, {
      method: 'DELETE',
    }),

  deleteComment: (id: number) =>
    call<{ bug: BugDetail }>(`/api/comments/${id}`, { method: 'DELETE' }),

  addBlocker: (id: number, blockerId: number) =>
    call<{ bug: BugDetail }>(`/api/bugs/${id}/blockers`, {
      method: 'POST',
      body: json({ blockerId }),
    }),

  removeBlocker: (id: number, blockerId: number) =>
    call<{ bug: BugDetail }>(`/api/bugs/${id}/blockers/${blockerId}`, { method: 'DELETE' }),

  comment: (id: number, body: string) =>
    call<{ bug: BugDetail }>(`/api/bugs/${id}/comments`, { method: 'POST', body: json({ body }) }),

  upload: (id: number, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    return call<{ bug: BugDetail }>(`/api/bugs/${id}/attachments`, { method: 'POST', body: form });
  },

  deleteAttachment: (id: number) =>
    call<{ bug: BugDetail }>(`/api/attachments/${id}`, { method: 'DELETE' }),

  users: (q?: string) =>
    call<{ users: AdminUser[] }>(`/api/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),

  setRole: (id: number, role: string) =>
    call<{ user: User }>(`/api/users/${id}/role`, { method: 'POST', body: json({ role }) }),

  assignable: () => call<{ users: User[] }>('/api/assignable'),

  // ---------------------------------------------------------------- admin

  adminSettings: () => call<{ settings: BoardSettings }>('/api/admin/settings'),

  updateAdminSettings: (settings: Partial<BoardSettings>) =>
    call<{ settings: BoardSettings }>('/api/admin/settings', {
      method: 'PATCH',
      body: json(settings),
    }),

  adminColumns: () => call<{ columns: AdminColumn[] }>('/api/admin/columns'),

  createColumn: (data: { label: string; color?: string }) =>
    call<{ column: AdminColumn }>('/api/admin/columns', { method: 'POST', body: json(data) }),

  updateColumn: (
    id: number,
    data: { label?: string; color?: string; intake?: boolean; terminal?: boolean },
  ) => call<{ column: AdminColumn }>(`/api/admin/columns/${id}`, { method: 'PATCH', body: json(data) }),

  reorderColumns: (ids: number[]) =>
    call<{ columns: AdminColumn[] }>('/api/admin/columns/reorder', {
      method: 'POST',
      body: json({ ids }),
    }),

  adminEnvironments: () => call<{ environments: AdminEnvironment[] }>('/api/admin/environments'),

  createEnvironment: (label: string) =>
    call<{ environments: string[] }>('/api/admin/environments', {
      method: 'POST',
      body: json({ label }),
    }),

  deleteEnvironment: (id: number) =>
    call<{ ok: true }>(`/api/admin/environments/${id}`, { method: 'DELETE' }),

  reorderEnvironments: (ids: number[]) =>
    call<{ environments: string[] }>('/api/admin/environments/reorder', {
      method: 'POST',
      body: json({ ids }),
    }),

  adminKinds: () =>
    call<{ kinds: AdminKind[]; hideableFields: string[]; labelSlots: string[] }>('/api/admin/kinds'),

  createKind: (data: { label: string; emoji?: string }) =>
    call<{ kind: AdminKind }>('/api/admin/kinds', { method: 'POST', body: json(data) }),

  updateKind: (
    id: number,
    data: {
      label?: string;
      emoji?: string;
      article?: string;
      hiddenFields?: string[];
      labels?: Record<string, string>;
    },
  ) => call<{ kind: AdminKind }>(`/api/admin/kinds/${id}`, { method: 'PATCH', body: json(data) }),

  deleteKind: (id: number, moveTo?: string) =>
    call<{ ok: true; moved: number }>(
      `/api/admin/kinds/${id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`,
      { method: 'DELETE' },
    ),

  createLevel: (kindId: number, data: { label: string; short?: string; color?: string }) =>
    call<{ kind: AdminKind }>(`/api/admin/kinds/${kindId}/levels`, {
      method: 'POST',
      body: json(data),
    }),

  updateLevel: (
    kindId: number,
    levelKey: string,
    data: { label?: string; short?: string; color?: string },
  ) =>
    call<{ kind: AdminKind }>(`/api/admin/kinds/${kindId}/levels/${encodeURIComponent(levelKey)}`, {
      method: 'PATCH',
      body: json(data),
    }),

  reorderLevels: (kindId: number, keys: string[]) =>
    call<{ kind: AdminKind }>(`/api/admin/kinds/${kindId}/levels/reorder`, {
      method: 'POST',
      body: json({ keys }),
    }),

  deleteLevel: (kindId: number, levelKey: string, moveTo?: string) =>
    call<{ kind: AdminKind; moved: number }>(
      `/api/admin/kinds/${kindId}/levels/${encodeURIComponent(levelKey)}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`,
      { method: 'DELETE' },
    ),

  deleteColumn: (id: number, moveTo?: string) =>
    call<{ ok: true; deleted: string; moved: number }>(
      `/api/admin/columns/${id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`,
      { method: 'DELETE' },
    ),
};
