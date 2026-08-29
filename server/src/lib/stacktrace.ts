import { createHash } from 'node:crypto';

/**
 * Turning a crash into something two machines can agree on.
 *
 * The same fault produces text that differs from user to user — a home
 * directory, a temp folder, the version in an install path, a heap address.
 * None of that identifies the bug, and all of it would make every occurrence
 * look brand new. Normalising rewrites those to placeholders; the fingerprint
 * is a hash of the result, so "have we seen this?" is an index lookup rather
 * than a fuzzy match nobody can predict.
 *
 * Deliberately kept exact-after-normalising rather than clever. A reporter can
 * be told precisely why two traces did or did not match; a similarity score
 * cannot.
 *
 * Normalising also means the stored trace carries no usernames or machine
 * paths, so the board stays publicly readable without leaking whose machine it
 * came from.
 */

/** A Windows, macOS or Linux home directory, whoever it belongs to. */
const HOME_PATTERNS: Array<[RegExp, string]> = [
  // C:\Users\james\  |  D:/Users/james/
  [/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/gi, '<HOME>'],
  // Legacy Windows
  [/\b[A-Za-z]:[\\/]Documents and Settings[\\/][^\\/\s"']+/gi, '<HOME>'],
  // /Users/james  (macOS)
  [/\/Users\/[^\\/\s"']+/g, '<HOME>'],
  // /home/james   (Linux)
  [/\/home\/[^\\/\s"']+/g, '<HOME>'],
];

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** 0x00007FF6A1B2C3D4 — a heap or module address, never the same twice. */
const ADDRESS = /\b0x[0-9a-f]{4,}\b/gi;

/** A dotted version, but only inside something that looks like a path. */
const VERSION_IN_PATH = /\d+(?:\.\d+){1,3}/g;

/** Windows temp folders keep a random segment per process. */
const TEMP_SEGMENT = /(<HOME>[\\/]AppData[\\/]Local[\\/]Temp[\\/])[^\\/\s"']+/gi;

function looksLikePath(token: string): boolean {
  return token.includes('\\') || token.includes('/');
}

/**
 * Replace versions only inside path-shaped tokens. An install directory named
 * after the release — ezmuze-studio-2026.8.2-win-x64-dx — would otherwise make
 * the same crash look new on every ship, while a version quoted in a *message*
 * ("expected 2.0 or later") is part of what the message means and must stay.
 */
function generalizeVersionsInPaths(text: string): string {
  return text.replace(/\S+/g, (token) =>
    looksLikePath(token) ? token.replace(VERSION_IN_PATH, '<VERSION>') : token,
  );
}

export function normalizeStackTrace(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n');

  for (const [pattern, replacement] of HOME_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(TEMP_SEGMENT, '$1<TMP>');
  text = generalizeVersionsInPaths(text);
  text = text.replace(GUID, '<GUID>');
  text = text.replace(ADDRESS, '<ADDR>');

  // Whitespace is presentation, not identity: a trace pasted into a form and
  // one read from a log differ only in indentation and trailing spaces.
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/** A .NET runtime identifier in an install path: win-x64-dx, osx-arm64, linux-x64. */
const RID = /\b(?:win|osx|linux|linux-musl|freebsd)-(?:x64|x86|arm64|arm)(?:-[a-z0-9]+)?\b/gi;

/**
 * A second pass, used only for matching and never shown.
 *
 * ezmuze ships Windows, macOS and Linux builds, so one fault in shared code
 * reaches us as three traces differing only in path separator and runtime
 * identifier. Folding those away here — rather than in `normalizeStackTrace` —
 * keeps the stored trace looking the way the reporter's machine wrote it, with
 * backslashes on Windows, while still grouping the three as one bug.
 */
function canonicalizeForMatching(normalized: string): string {
  return normalized
    .replace(/\S+/g, (token) =>
      looksLikePath(token) ? token.replace(/\\/g, '/').replace(RID, '<RID>') : token,
    )
    .toLowerCase();
}

/**
 * Stable id for a trace. Null for anything too short to be a real one — a
 * single line of "it crashed" must not make every future crash a duplicate of
 * it.
 */
export function fingerprintStackTrace(raw: string): string | null {
  const normalized = normalizeStackTrace(raw);
  if (normalized.length < 20) return null;
  return createHash('sha256').update(canonicalizeForMatching(normalized)).digest('hex');
}
