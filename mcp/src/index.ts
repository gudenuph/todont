#!/usr/bin/env node
/**
 * MCP server over the tracker's REST API, so Claude can work the board the same
 * way a manager does in the browser: read the queue, pick something up, move it
 * along, and leave the ticket updated.
 *
 * Configure with:
 *   TRACKER_URL    default https://bugs.ezmuze.studio
 *   TRACKER_TOKEN  an API token with read,write,manage (server CLI: `token`)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.TRACKER_URL ?? 'https://bugs.ezmuze.studio').replace(/\/$/, '');
const TOKEN = process.env.TRACKER_TOKEN ?? '';

if (!TOKEN) {
  console.error('TRACKER_TOKEN is not set — every call will come back 401.');
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }

  return body;
}

/** Every tool answers with JSON text — the model reads it far better than prose. */
function reply(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

const server = new McpServer({ name: 'todont-tracker', version: '1.0.0' });

server.registerTool(
  'list_columns',
  {
    title: 'List board columns',
    description: 'The board’s columns in order, with the key each bug’s status uses.',
    inputSchema: {},
  },
  async () => {
    try {
      return reply(await call('/api/meta'));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'list_bugs',
  {
    title: 'List bugs',
    description:
      'The board. Filter by column, free text, or assignee. Merged duplicates are hidden unless asked for.',
    inputSchema: {
      status: z.string().optional().describe('Column key, e.g. "unconfirmed" or "in-progress"'),
      kind: z.enum(['bug', 'feature']).optional().describe('Only bugs, or only feature requests'),
      q: z.string().optional().describe('Free-text search over title, description and steps'),
      assigneeId: z.number().optional(),
      includeMerged: z.boolean().optional(),
    },
  },
  async ({ status, kind, q, assigneeId, includeMerged }) => {
    try {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (kind) qs.set('kind', kind);
      if (q) qs.set('q', q);
      if (assigneeId !== undefined) qs.set('assignee', String(assigneeId));
      if (includeMerged) qs.set('includeMerged', 'true');
      const suffix = qs.toString() ? `?${qs}` : '';
      return reply(await call(`/api/bugs${suffix}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'get_bug',
  {
    title: 'Read one bug',
    description: 'Full detail: description, steps, attachments, comments, activity and duplicates.',
    inputSchema: { id: z.number().describe('Bug number, as shown on the card') },
  },
  async ({ id }) => {
    try {
      return reply(await call(`/api/bugs/${id}`));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'create_bug',
  {
    title: 'Raise a bug',
    description:
      'Raise a new bug. It lands in Unconfirmed unless a status is given. Pass externalRef to make repeat calls idempotent.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      steps: z.string().optional(),
      expected: z.string().optional(),
      actual: z.string().optional(),
      severity: z.enum(['critical', 'major', 'minor', 'trivial']).optional(),
      appVersion: z.string().optional(),
      environment: z.string().optional(),
      status: z.string().optional(),
      kind: z
        .enum(['bug', 'feature'])
        .optional()
        .describe('Defaults to "bug". A feature request rides the same board and columns.'),
      externalRef: z.string().optional(),
    },
  },
  async (args) => {
    try {
      return reply(await call('/api/bugs', { method: 'POST', body: JSON.stringify(args) }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'update_bug',
  {
    title: 'Edit a bug',
    description: 'Rewrite the descriptive fields of a bug. Only the fields you pass change.',
    inputSchema: {
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      steps: z.string().optional(),
      expected: z.string().optional(),
      actual: z.string().optional(),
      severity: z.enum(['critical', 'major', 'minor', 'trivial']).optional(),
      kind: z.enum(['bug', 'feature']).optional().describe('Retype the ticket'),
      appVersion: z.string().optional(),
      environment: z.string().optional(),
    },
  },
  async ({ id, ...fields }) => {
    try {
      return reply(await call(`/api/bugs/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'move_bug',
  {
    title: 'Move a bug to another column',
    description:
      'The API equivalent of dragging a card. Omit index to drop it at the bottom of the column.',
    inputSchema: {
      id: z.number(),
      status: z.string().describe('Target column key — see list_columns'),
      index: z.number().optional().describe('0 puts it at the top of the column'),
    },
  },
  async ({ id, status, index }) => {
    try {
      return reply(
        await call(`/api/bugs/${id}/move`, { method: 'POST', body: JSON.stringify({ status, index }) }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'merge_bugs',
  {
    title: 'Merge a duplicate',
    description:
      'Mark `id` a duplicate of `intoId`, the same as dropping one card on another. The duplicate leaves the board and is listed on the bug it merged into.',
    inputSchema: {
      id: z.number().describe('The duplicate, which leaves the board'),
      intoId: z.number().describe('The bug that keeps the discussion'),
    },
  },
  async ({ id, intoId }) => {
    try {
      return reply(
        await call(`/api/bugs/${id}/merge`, { method: 'POST', body: JSON.stringify({ intoId }) }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'unmerge_bug',
  {
    title: 'Split a duplicate back out',
    description: 'Undo a merge. The bug returns to the bottom of its column.',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    try {
      return reply(await call(`/api/bugs/${id}/unmerge`, { method: 'POST' }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'assign_bug',
  {
    title: 'Assign a bug',
    description: 'Set or clear the assignee. Pass userId null to unassign. See list_assignable.',
    inputSchema: { id: z.number(), userId: z.number().nullable() },
  },
  async ({ id, userId }) => {
    try {
      return reply(
        await call(`/api/bugs/${id}/assign`, { method: 'POST', body: JSON.stringify({ userId }) }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'comment_bug',
  {
    title: 'Comment on a bug',
    description: 'Add a comment to the bug’s thread, as whoever the token acts as.',
    inputSchema: { id: z.number(), body: z.string() },
  },
  async ({ id, body }) => {
    try {
      return reply(
        await call(`/api/bugs/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'delete_bug',
  {
    title: 'Delete a bug',
    description:
      'Permanently remove a bug with its comments and attachments — moderation for spam and mistakes. There is no undo. Any duplicates merged into it are released back onto their columns. Prefer moving a bug to "rejected" unless it genuinely should not exist.',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    try {
      return reply(await call(`/api/bugs/${id}`, { method: 'DELETE' }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'delete_comment',
  {
    title: 'Delete a comment',
    description: 'Remove one comment from a bug’s thread. Manager-only, and permanent.',
    inputSchema: { id: z.number().describe('The comment id, from get_bug') },
  },
  async ({ id }) => {
    try {
      return reply(await call(`/api/comments/${id}`, { method: 'DELETE' }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'delete_attachment',
  {
    title: 'Delete an attachment',
    description: 'Remove one attachment and its file from disk. Permanent.',
    inputSchema: { id: z.number().describe('The attachment id, from get_bug') },
  },
  async ({ id }) => {
    try {
      return reply(await call(`/api/attachments/${id}`, { method: 'DELETE' }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'list_assignable',
  {
    title: 'List who a bug can be assigned to',
    description: 'The managers, admins and bots a bug can be assigned to.',
    inputSchema: {},
  },
  async () => {
    try {
      return reply(await call('/api/assignable'));
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
