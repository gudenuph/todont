#!/usr/bin/env node
/**
 * MCP server over the tracker's REST API, so Claude can work the board the same
 * way a manager does in the browser: read the queue, pick something up, move it
 * along, and leave the ticket updated.
 *
 * Configure with:
 *   TRACKER_URL    default http://127.0.0.1:4310
 *   TRACKER_TOKEN  an API token with read,write,manage (server CLI: `token`)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Local by default: a fresh clone should talk to the instance you are
// running, never to somebody else's board.
const BASE = (process.env.TRACKER_URL || 'http://127.0.0.1:4310').replace(/\/$/, '');
const TOKEN = process.env.TRACKER_TOKEN ?? '';

if (!TOKEN) {
  console.error('TRACKER_TOKEN is not set — every call will come back 401.');
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      // Only for a JSON body. FormData sets its own type and, crucially, its
      // boundary — declaring JSON over it makes the server read the multipart
      // envelope as a broken JSON document.
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
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

/**
 * What a file actually is, from its first bytes.
 *
 * The extension is not asked. This tool takes a path from a model and puts the
 * contents on a world-readable board, so "it is called .png" is not good enough
 * — the bytes have to agree. Anything that is not really an image or a
 * recording is refused rather than uploaded and served as one.
 */
function sniff(buf: Buffer): string | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  // MP4 and friends: a `ftyp` box, which does not start the file.
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';

  return null;
}

/** The server's own ceiling is higher; this is a sane one for a tool call. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

async function readImages(paths: string[]): Promise<Array<{ name: string; blob: Blob }>> {
  return Promise.all(
    paths.map(async (given) => {
      const file = path.resolve(given);

      let buf: Buffer;
      try {
        buf = await fs.readFile(file);
      } catch {
        throw new Error(`Cannot read ${given} — give a path to a file on this machine`);
      }

      if (buf.length > MAX_IMAGE_BYTES) {
        throw new Error(
          `${path.basename(file)} is ${Math.round(buf.length / 1024 / 1024)}MB, over the ${
            MAX_IMAGE_BYTES / 1024 / 1024
          }MB limit`,
        );
      }

      const mime = sniff(buf);
      if (!mime) {
        throw new Error(
          `${path.basename(file)} is not a PNG, JPEG, GIF, WebP, WebM or MP4 — ` +
            'nothing else can go on a comment',
        );
      }

      return {
        name: path.basename(file),
        blob: new Blob([new Uint8Array(buf)], { type: mime }),
      };
    }),
  );
}

const server = new McpServer({ name: 'todont-tracker', version: '1.0.0' });

server.registerTool(
  'list_columns',
  {
    title: 'List board columns',
    description:
      'The board’s columns in order, the ticket kinds (bug, feature request) and each kind’s level scale and wording.',
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
    description:
      'Full detail: description, steps, attachments, comments, activity, duplicates, and what this ticket is blocked by and blocking.',
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
      severity: z
        .string()
        .optional()
        .describe(
          'How much it matters. The scale depends on kind: a bug takes critical | major | \nminor | trivial, a feature request takes blocking | important | want | idea. list_columns \nreturns both.',
        ),
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
      severity: z
        .string()
        .optional()
        .describe(
          'How much it matters. The scale depends on kind: a bug takes critical | major | \nminor | trivial, a feature request takes blocking | important | want | idea. list_columns \nreturns both.',
        ),
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
    description:
      'Add a comment to the bug’s thread, as whoever the token acts as. Images can be ' +
      'attached by path — a screenshot, a chart, a before-and-after — and are posted with ' +
      'the comment in one go. An image on its own is a valid comment.',
    inputSchema: {
      id: z.number(),
      body: z.string().default('').describe('May be empty when images are attached'),
      images: z
        .array(z.string())
        .optional()
        .describe(
          'Paths to image or video files on this machine (PNG, JPEG, GIF, WebP, WebM, MP4). ' +
            'They are uploaded to a board anyone can read, so do not attach anything private.',
        ),
    },
  },
  async ({ id, body, images }) => {
    try {
      if (!images?.length) {
        if (!body.trim()) throw new Error('A comment needs either text or an image');
        return reply(
          await call(`/api/bugs/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
        );
      }

      // Read and check every file before sending any of it, so a bad path in
      // the list does not leave half a comment on the board.
      const files = await readImages(images);

      const form = new FormData();
      form.append('body', body);
      for (const file of files) form.append('file', file.blob, file.name);

      // No content-type header: fetch sets it, boundary and all.
      return reply(await call(`/api/bugs/${id}/comments`, { method: 'POST', body: form }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'block_bug',
  {
    title: 'Mark a ticket blocked by another',
    description:
      '"`id` cannot start until `blockerId` is done." Refused if it would close a loop — directly, or through other tickets.',
    inputSchema: {
      id: z.number().describe('The ticket that has to wait'),
      blockerId: z.number().describe('The ticket it is waiting on'),
    },
  },
  async ({ id, blockerId }) => {
    try {
      return reply(
        await call(`/api/bugs/${id}/blockers`, {
          method: 'POST',
          body: JSON.stringify({ blockerId }),
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'unblock_bug',
  {
    title: 'Remove a blocker',
    description: 'Drop the dependency between two tickets.',
    inputSchema: { id: z.number(), blockerId: z.number() },
  },
  async ({ id, blockerId }) => {
    try {
      return reply(await call(`/api/bugs/${id}/blockers/${blockerId}`, { method: 'DELETE' }));
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
  'list_versions',
  {
    title: 'List ezmuze versions',
    description:
      'The versions a reporter can pick, newest release first with "Unreleased" last. Registered by the ezmuze publishing pipeline, so this changes without a deploy.',
    inputSchema: {},
  },
  async () => {
    try {
      return reply(await call('/api/versions'));
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
