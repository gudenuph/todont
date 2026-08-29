import type { AdminUser, BugCard, BugDetail, Meta, Session, User } from './types';

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
  me: () => call<Session>('/api/me'),

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
};
