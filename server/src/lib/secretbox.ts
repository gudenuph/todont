import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Encryption for the few things that must sit in the database but must not be
 * readable from a copy of it.
 *
 * The key is derived from `COOKIE_SECRET`, which lives in the environment file
 * and is deliberately **not** in a backup archive. That is the whole point: a
 * stolen or mis-sent backup is a copy of the board, not a set of working
 * credentials, because the key to open them was never in the tarball.
 *
 * AES-256-GCM, so a tampered value fails to decrypt rather than decrypting to
 * something an attacker chose.
 */

const VERSION = 'v1';

/** Derived once. HKDF, so the cookie secret is not used as a key directly. */
let cached: Buffer | null = null;
function key(): Buffer {
  if (!cached) {
    cached = Buffer.from(
      hkdfSync('sha256', config.cookieSecret, 'todont-secretbox', 'auth-key-at-rest', 32),
    );
  }
  return cached;
}

/** Exposed for tests, which build several apps in one process. */
export function resetSecretbox(): void {
  cached = null;
}

/** `v1:<base64url(iv | tag | ciphertext)>` — one column, self-describing. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

/**
 * The reverse, and never throws.
 *
 * Returns null when the value cannot be opened — a changed `COOKIE_SECRET`, a
 * truncated row, a tampered one. Callers treat that as "no key available",
 * which degrades to skipping revalidation rather than to an error page.
 */
export function open(sealed: string | null): string | null {
  if (!sealed) return null;

  // Written before this existed. Only reachable until the boot migration has
  // run once, and harmless to accept in the meantime.
  if (!sealed.startsWith(`${VERSION}:`)) return sealed;

  try {
    const raw = Buffer.from(sealed.slice(VERSION.length + 1), 'base64url');
    if (raw.length <= 28) return null;

    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Whether a stored value has already been through `seal`. */
export function isSealed(value: string | null): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}
