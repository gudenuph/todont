import { createHash, createHmac } from 'node:crypto';

/**
 * A single PutObject against anything S3-compatible, signed by hand.
 *
 * The AWS SDK is tens of megabytes for one request; this is the whole of
 * Signature Version 4 for one verb, in about eighty lines, with no dependency
 * at all. That matters for an image meant to run on a small box.
 *
 * Path-style addressing (`endpoint/bucket/key`) because that is what Backblaze
 * B2, Cloudflare R2 and MinIO all accept, and what a self-hoster is most
 * likely to be pointing at.
 */

export interface S3Target {
  /** https://s3.eu-central-003.backblazeb2.com, https://<id>.r2.cloudflarestorage.com, … */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Folder inside the bucket, optional. */
  prefix?: string;
}

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** Everything except unreserved characters, and never the slashes in a path. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    ))
    .join('/');
}

export async function putObject(
  target: S3Target,
  key: string,
  body: Buffer,
  contentType = 'application/octet-stream',
): Promise<void> {
  const endpoint = target.endpoint.replace(/\/+$/, '');
  const url = new URL(endpoint);

  const objectKey = [target.prefix?.replace(/^\/+|\/+$/g, ''), key].filter(Boolean).join('/');
  const canonicalUri = encodePath(`/${target.bucket}/${objectKey}`);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260831T012345Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hash(body);

  // Host must be exactly what goes on the wire, port included when non-default.
  const host = url.host;

  const headers: Record<string, string> = {
    host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h].trim()}\n`)
    .join('');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '', // no query
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonicalRequest)].join('\n');

  const signingKey = ['s3', 'aws4_request'].reduce(
    (key, part) => hmac(key, part),
    hmac(hmac(`AWS4${target.secretAccessKey}`, dateStamp), target.region),
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`${url.origin}${canonicalUri}`, {
    method: 'PUT',
    headers: { ...headers, authorization },
    body: new Uint8Array(body),
  });

  if (!res.ok) {
    // S3 errors are XML; the code element is the useful part.
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
    throw new Error(
      `storage refused the upload (HTTP ${res.status})${code ? `: ${code}` : ''}` +
        `${message ? ` — ${message}` : ''}`,
    );
  }
}
