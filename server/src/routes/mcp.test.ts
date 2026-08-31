import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, signUp, body, ONE_PIXEL_PNG, type Harness } from '../test/harness.js';

/**
 * The MCP server, driven the way Claude Code drives it: a real process, real
 * stdio, real JSON-RPC, talking to a real tracker over HTTP.
 *
 * Worth the setup because this is the one surface where nothing else would
 * notice a break — no browser opens it and no route test imports it.
 */

let h: Harness;
let cookie: string;
let token: string;
let origin: string;
let bugId: number;
let mcp: ChildProcessWithoutNullStreams;
let shot: string;
let notAnImage: string;

/** Newline-delimited JSON-RPC, one request at a time. */
function rpc(method: string, params: unknown, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();

      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // a partial line; the next chunk completes it
        }
        if (message.id === id) {
          mcp.stdout.off('data', onData);
          resolve(message);
          return;
        }
      }
    };

    mcp.stdout.on('data', onData);
    setTimeout(() => {
      mcp.stdout.off('data', onData);
      reject(new Error(`no reply to ${method}`));
    }, 15_000).unref();

    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** Call a tool and hand back the text it answered with. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<{ text: string; isError: boolean }> {
  const res = (await rpc('tools/call', { name, arguments: args }, id)) as {
    result?: { content: Array<{ text: string }>; isError?: boolean };
    error?: { message: string };
  };

  if (res.error) throw new Error(res.error.message);
  return {
    text: res.result?.content?.[0]?.text ?? '',
    isError: res.result?.isError === true,
  };
}

before(async () => {
  h = await makeApp();
  cookie = await signUp(h.app, 'boss@example.com');

  // A real port: the MCP server speaks HTTP, not inject().
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  token = body<{ token: string }>(
    await h.app.inject({
      method: 'POST',
      url: '/api/tokens',
      cookies: { todont_session: cookie },
      payload: { name: 'mcp-test', scopes: ['read', 'write', 'manage'], botName: 'Claude' },
    }),
  ).token;

  bugId = body<{ bug: { id: number } }>(
    await h.app.inject({
      method: 'POST',
      url: '/api/bugs',
      cookies: { todont_session: cookie },
      payload: { title: 'Something for Claude to look at' },
    }),
  ).bug.id;

  shot = path.join(h.dir, 'evidence.png');
  await fs.writeFile(shot, ONE_PIXEL_PNG);

  // A text file wearing a .png name, which is the case that matters.
  notAnImage = path.join(h.dir, 'secrets.png');
  await fs.writeFile(notAnImage, 'ACCESS_KEY=not-really-a-secret');

  const entry = fileURLToPath(new URL('../../../mcp/dist/index.js', import.meta.url));
  mcp = spawn(process.execPath, [entry], {
    env: { ...process.env, TRACKER_URL: origin, TRACKER_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  await rpc(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'todont-test', version: '1.0.0' },
    },
    1,
  );
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
});

after(async () => {
  mcp?.kill();
  await h.close();
});

test('the tool advertises that it takes images', async () => {
  const res = (await rpc('tools/list', {}, 2)) as {
    result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
  };

  const comment = res.result.tools.find((t) => t.name === 'comment_bug');
  assert.ok(comment, 'comment_bug is missing');
  assert.ok(comment.inputSchema.properties.images, 'images is not on the schema');
});

test('Claude comments with a screenshot, and it lands on the board', async () => {
  const { text, isError } = await callTool(
    'comment_bug',
    { id: bugId, body: 'Here is what I see:', images: [shot] },
    3,
  );

  assert.equal(isError, false, text);

  const detail = body<{
    bug: { comments: Array<{ body: string; attachments: Array<{ mime: string; url: string }> }> };
  }>(await h.app.inject({ method: 'GET', url: `/api/bugs/${bugId}` })).bug;

  const posted = detail.comments.at(-1)!;
  assert.equal(posted.body, 'Here is what I see:');
  assert.equal(posted.attachments.length, 1);
  assert.equal(posted.attachments[0].mime, 'image/png');

  // The bytes really made the round trip.
  const fetched = await h.app.inject({ method: 'GET', url: posted.attachments[0].url });
  assert.deepEqual(fetched.rawPayload, ONE_PIXEL_PNG);
});

test('an image on its own is a comment', async () => {
  const { isError, text } = await callTool('comment_bug', { id: bugId, images: [shot] }, 4);
  assert.equal(isError, false, text);

  const detail = body<{ bug: { comments: Array<{ body: string; attachments: unknown[] }> } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bugId}` }),
  ).bug;

  assert.equal(detail.comments.at(-1)!.body, '');
  assert.equal(detail.comments.at(-1)!.attachments.length, 1);
});

test('a file that is not really an image is refused, not uploaded', async () => {
  const before = body<{ bug: { comments: unknown[] } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bugId}` }),
  ).bug.comments.length;

  const { text, isError } = await callTool(
    'comment_bug',
    { id: bugId, body: 'Trust me', images: [notAnImage] },
    5,
  );

  assert.equal(isError, true);
  assert.match(text, /not a PNG/);

  const after = body<{ bug: { comments: unknown[] } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bugId}` }),
  ).bug.comments.length;

  assert.equal(after, before, 'a comment was left behind by a refused upload');
});

test('one bad path in the list posts nothing at all', async () => {
  const before = body<{ bug: { comments: unknown[] } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bugId}` }),
  ).bug.comments.length;

  const { text, isError } = await callTool(
    'comment_bug',
    { id: bugId, body: 'Two files', images: [shot, path.join(h.dir, 'no-such-file.png')] },
    6,
  );

  assert.equal(isError, true);
  assert.match(text, /Cannot read/);

  const after = body<{ bug: { comments: unknown[] } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bugId}` }),
  ).bug.comments.length;

  assert.equal(after, before, 'half a comment was posted');
});

test('a comment with neither words nor pictures is refused', async () => {
  const { isError } = await callTool('comment_bug', { id: bugId, body: '   ' }, 7);
  assert.equal(isError, true);
});

test('plain text comments still work through the tool', async () => {
  const { isError, text } = await callTool('comment_bug', { id: bugId, body: 'Just words' }, 8);
  assert.equal(isError, false, text);

  const detail = body<{ bug: { comments: Array<{ body: string; attachments: unknown[] }> } }>(
    await h.app.inject({ method: 'GET', url: `/api/bugs/${bugId}` }),
  ).bug;

  assert.equal(detail.comments.at(-1)!.body, 'Just words');
  assert.deepEqual(detail.comments.at(-1)!.attachments, []);
});
