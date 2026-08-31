import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintStackTrace, normalizeStackTrace } from './stacktrace.js';

const B = String.fromCharCode(92); // backslash, kept out of the literals

const winJames =
  'System.IO.DirectoryNotFoundException: LocalContentHandler could not find a wwwroot folder next to ' +
  `C:${B}Users${B}james${B}Downloads${B}ezmuze-studio-2026.8.2-win-x64-dx${B}, nor ezmuze-studio.sln above it`;

const winSarah =
  'System.IO.DirectoryNotFoundException: LocalContentHandler could not find a wwwroot folder next to ' +
  `C:${B}Users${B}sarah.oconnor${B}Downloads${B}ezmuze-studio-2026.9.0-win-x64-dx${B}, nor ezmuze-studio.sln above it`;

const mac =
  'System.IO.DirectoryNotFoundException: LocalContentHandler could not find a wwwroot folder next to ' +
  '/Users/dave/Downloads/ezmuze-studio-2026.8.2-osx-arm64/, nor ezmuze-studio.sln above it';

const linux =
  'System.IO.DirectoryNotFoundException: LocalContentHandler could not find a wwwroot folder next to ' +
  '/home/pat/Downloads/ezmuze-studio-2026.8.2-linux-x64/, nor ezmuze-studio.sln above it';

const same = (a: string, b: string) => fingerprintStackTrace(a) === fingerprintStackTrace(b);

test('a home directory is generalised, whoever it belongs to', () => {
  const out = normalizeStackTrace(winJames);
  assert.ok(out.includes('<HOME>'), out);
  assert.ok(!out.includes('james'), out);
});

test('a version inside a path is generalised, so a release does not look like a new fault', () => {
  assert.ok(normalizeStackTrace(winJames).includes('<VERSION>'));
});

test('a version quoted in a message is left alone', () => {
  const message = 'System.Exception: expected 2.0 or later but this build targets something else';
  assert.equal(normalizeStackTrace(message), message);
});

test('the same fault from different users and versions is one fingerprint', () => {
  assert.ok(same(winJames, winSarah));
});

test('the same fault groups across Windows, macOS and Linux builds', () => {
  assert.ok(same(winJames, mac), 'windows vs macOS');
  assert.ok(same(winJames, linux), 'windows vs linux');
  assert.ok(same(mac, linux), 'macOS vs linux');
});

test('a genuinely different fault does not group', () => {
  const other =
    'System.IO.FileNotFoundException: LocalContentHandler could not find a preset folder next to ' +
    '/home/pat/Downloads/ezmuze-studio-2026.8.2-linux-x64/';
  assert.ok(!same(winJames, other));
});

test('guids and heap addresses are generalised', () => {
  const a =
    'System.AccessViolationException at 0x00007FF6A1B2C3D4 for 5f2c9a10-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
  const b =
    'System.AccessViolationException at 0x00007FFAB9C0D1E2 for 9911aabb-ccdd-eeff-0011-223344556677';
  assert.ok(same(a, b));
});

test('whitespace is presentation, not identity', () => {
  assert.ok(same(winJames, `   ${winJames}\n\n\n`));
});

test('something too short to be a trace has no fingerprint', () => {
  assert.equal(fingerprintStackTrace('it crashed'), null);
  assert.equal(fingerprintStackTrace(''), null);
});

test('a real trace has one, and it is stable across calls', () => {
  const first = fingerprintStackTrace(winJames);
  assert.ok(first);
  assert.equal(first, fingerprintStackTrace(winJames));
});
