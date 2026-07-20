/**
 * @fileoverview Regression tests for the body-ref URI helpers.
 *
 * Locks down the macOS/Linux bug where a hand-rolled `file:///` +
 * `os.tmpdir()` (which already starts with `/`) produced `file:////var/...`
 * and then exploded with `[UriError]: ... path cannot begin with two slash
 * characters ("//")` inside the save-to-file handler.
 */

import { describe, expect, it } from 'vitest';
import { bodyRefFor, isFileUri } from './body-ref-utils';

describe('bodyRefFor', () => {
  it('returns a file:// URI that round-trips through URL for a macOS-style absolute path', () => {
    const tmpFile = '/var/folders/abc/T/volt-resp-corr123.txt';
    const uri = bodyRefFor(tmpFile);

    expect(uri).toBe('file:///var/folders/abc/T/volt-resp-corr123.txt');
    expect(uri).not.toContain('////');

    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('file:');
    expect(parsed.pathname).toBe('/var/folders/abc/T/volt-resp-corr123.txt');
  });

  it('returns a file:// URI for a Linux absolute path', () => {
    const tmpFile = '/tmp/volt-resp-corr123.txt';
    const uri = bodyRefFor(tmpFile);

    expect(uri).toBe('file:///tmp/volt-resp-corr123.txt');
    expect(new URL(uri).pathname).toBe('/tmp/volt-resp-corr123.txt');
  });

  it('returns a file:// URI for a Windows-style path (pathToFileURL normalises drive letters)', () => {
    const tmpFile = 'C:\\Users\\me\\AppData\\Local\\Temp\\volt-resp-corr123.txt';
    const uri = bodyRefFor(tmpFile);

    expect(uri.startsWith('file:///')).toBe(true);
    expect(uri.toLowerCase()).toContain('volt-resp-corr123.txt');
  });

  it('percent-encodes characters that would otherwise break the URI', () => {
    const tmpFile = '/tmp/volt resp with spaces.txt';
    const uri = bodyRefFor(tmpFile);

    expect(uri).not.toContain(' ');
    const parsed = new URL(uri);
    expect(parsed.pathname).toBe('/tmp/volt%20resp%20with%20spaces.txt');
  });
});

describe('isFileUri', () => {
  it('accepts a well-formed file:// URI from a macOS path', () => {
    expect(isFileUri(bodyRefFor('/var/folders/abc/T/volt-resp-corr123.txt'))).toBe(true);
  });

  it('rejects the old broken shape that the bug used to produce', () => {
    // Simulates the old `file:///` + `/var/folders/...` concatenation.
    // We construct it without using pathToFileURL so the assertion proves
    // the helper does not blindly trust string prefixes.
    const broken = 'file://' + '/' + '/var/folders/abc/T/volt-resp-corr123.txt';
    expect(broken.startsWith('file:///')).toBe(true);
    expect(isFileUri(broken)).toBe(false);
  });

  it('rejects non-file URIs', () => {
    expect(isFileUri('https://example.com/foo')).toBe(false);
    expect(isFileUri('http://localhost:3000/x')).toBe(false);
    expect(isFileUri('plain text content')).toBe(false);
  });

  it('rejects empty and malformed strings without throwing', () => {
    expect(isFileUri('')).toBe(false);
    expect(isFileUri('not a url at all')).toBe(false);
  });
});
