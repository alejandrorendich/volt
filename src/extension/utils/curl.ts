/**
 * @fileoverview cURL command generator — extension host side.
 *
 * Mirrors the webview-side `src/webview/utils/curl.ts` but uses `os.platform()`
 * for Windows detection instead of `navigator.platform`.
 *
 * @see REQ-RV-005 — Copy as cURL
 */

import * as os from 'os';
import type { HttpRequestDef } from '../../shared/models';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

const isWindows: boolean = os.platform() === 'win32';

// ---------------------------------------------------------------------------
// Shell quoting helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a string in platform-appropriate shell quotes.
 *
 * - **Unix**: single-quoted (`'...'`), internal single-quotes escaped as `'\''`.
 * - **Windows PowerShell**: double-quoted (`"..."`), internal double-quotes
 *   escaped with a backtick.
 */
function escapeShell(s: string): string {
  if (isWindows) {
    return `"${s.replace(/"/g, '`"')}"`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a cURL command string from an `HttpRequestDef`.
 *
 * @param request - The request definition to convert.
 * @returns A cURL command string ready to copy.
 */
export function buildCurlCommand(request: HttpRequestDef): string {
  const parts: string[] = ['curl'];

  // Method
  if (request.method !== 'GET') {
    parts.push(`-X ${request.method}`);
  }

  // Skip SSL verification flag
  if (request.settings?.sslVerify === false) {
    parts.push('-k');
  }

  // Headers
  for (const [key, value] of Object.entries(request.headers)) {
    parts.push(`-H ${escapeShell(`${key}: ${value}`)}`);
  }

  // Body
  if (request.body && request.body.type !== 'none') {
    const content = 'content' in request.body ? request.body.content : '';
    if (request.body.type === 'json') {
      if (!hasHeader(request, 'content-type')) {
        parts.push(`-H ${escapeShell('Content-Type: application/json')}`);
      }
      parts.push(`-d ${escapeShell(content)}`);
    } else if (request.body.type === 'text') {
      parts.push(`-d ${escapeShell(content)}`);
    } else if (request.body.type === 'form-data') {
      const pairs = content.split('\n').filter(Boolean);
      for (const pair of pairs) {
        parts.push(`--data-urlencode ${escapeShell(pair)}`);
      }
    }
  }

  // URL (always last)
  parts.push(escapeShell(request.url));

  return parts.join(' \\\n  ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasHeader(request: HttpRequestDef, name: string): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === name.toLowerCase());
}
