import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * scrypt, from Node's own crypto.
 *
 * Deliberately not bcrypt or argon2: both are native modules, and this project
 * has already had to work around native-build friction once. scrypt is a real
 * password KDF, is memory-hard, and ships in the runtime.
 *
 * Parameters travel inside the stored string, so raising them later does not
 * invalidate existing passwords — an old hash still verifies against the
 * settings it was made with.
 */
const N = 16_384; // ~16MB of memory per hash at r=8
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Constant-time check. Returns false rather than throwing on a malformed hash:
 * a corrupted row should fail a login, not take the endpoint down.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }

  try {
    const actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** What a password has to be. Length only — rules beyond it mostly annoy. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password must be text';
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters`;
  }
  if (password.length > MAX_PASSWORD) {
    return `Password must be at most ${MAX_PASSWORD} characters`;
  }
  return null;
}

/**
 * Light-touch validation. Deliverability is not our business — we send no mail —
 * so this only rejects what obviously is not an address.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
