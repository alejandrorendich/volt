/**
 * @fileoverview cURL command generator.
 *
 * Builds a valid cURL command string from a request + response pair.
 * The output can be pasted directly into a terminal to reproduce the request.
 *
 * @see REQ-RV-005 — Copy as cURL
 */

import type { HttpRequestDef } from '../../shared/models';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the webview is running in a Windows host environment.
 * `navigator.platform` is available in browser contexts (webview).
 * Falls back to checking `navigator.userAgent` for "Win" as a secondary signal.
 */
const isWindows: boolean = (() => {
  if (typeof navigator !== 'undefined') {
    const p = navigator.platform ?? '';
    if (p.startsWith('Win')) return true;
    // platform can be empty in some WebView2 contexts — fall back to userAgent
    return navigator.userAgent.includes('Windows');
  }
  return false;
})();

// ---------------------------------------------------------------------------
// Shell quoting helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a string in platform-appropriate shell quotes.
 *
 * - **Unix**: single-quoted (`'...'`), internal single-quotes escaped as `'\''`.
 * - **Windows PowerShell**: double-quoted (`"..."`), internal double-quotes
 *   escaped with a backtick (`` `" ``).
 */
function escapeShell(s: string): string {
  if (isWindows) {
    // PowerShell: double quotes, escape internal double quotes with backtick
    return `"${s.replace(/"/g, '`"')}"`;
  }
  // Unix: single quotes, escape internal single quotes with '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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

  // Headers
  for (const [key, value] of Object.entries(request.headers)) {
    parts.push(`-H ${escapeShell(`${key}: ${value}`)}`);
  }

  // Body
  if (request.body && request.body.type !== 'none') {
    const content = 'content' in request.body ? request.body.content : '';
    if (request.body.type === 'json') {
      // Ensure Content-Type header is present
      if (!hasHeader(request, 'content-type')) {
        parts.push(`-H ${escapeShell('Content-Type: application/json')}`);
      }
      parts.push(`-d ${escapeShell(content)}`);
    } else if (request.body.type === 'text') {
      parts.push(`-d ${escapeShell(content)}`);
    } else if (request.body.type === 'form-data') {
      // form-data: each key=value pair as --data-urlencode
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

/** Check if a request already has a given header (case-insensitive). */
function hasHeader(request: HttpRequestDef, name: string): boolean {
  return Object.keys(request.headers).some((k) => k.toLowerCase() === name.toLowerCase());
}
