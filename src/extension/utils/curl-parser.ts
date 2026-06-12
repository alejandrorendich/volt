/**
 * @fileoverview cURL command parser — converts a cURL command string into an
 * HttpRequestDef that can be saved as a Volt request.
 *
 * Supported flags:
 * - `-X METHOD` / `--request METHOD`        — HTTP method
 * - `-H "Key: Value"` / `--header "K: V"`   — headers
 * - `-d "data"` / `--data "data"` / `--data-raw "data"` — request body
 * - `--data-urlencode "key=value"`           — URL-encoded form body
 * - `-u user:pass` / `--user user:pass`      — Basic auth (injected as header)
 * - `--compressed`                           — ignored (Volt handles automatically)
 * - `-k` / `--insecure`                      — disable SSL verification
 * - Lines ending with `\` are joined (multiline cURL)
 *
 * @see REQ-EXT-009 — Import from cURL
 */

import type { HttpRequestDef, HttpMethod, RequestBody } from '../../shared/models';

// ---------------------------------------------------------------------------
// Token parser — splits a cURL command line into flag/value tokens
// ---------------------------------------------------------------------------

/**
 * Tokenize a cURL command string into an array of string tokens,
 * respecting single-quoted and double-quoted strings.
 */
function tokenize(input: string): string[] {
  // Join multiline cURL (trailing backslash-newline)
  const joined = input.replace(/\\\n/g, ' ').replace(/\\\r\n/g, ' ');

  const tokens: string[] = [];
  let i = 0;
  const len = joined.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(joined[i] ?? '')) i++;
    if (i >= len) break;

    const ch = joined[i];

    if (ch === "'") {
      // Single-quoted string
      i++;
      let token = '';
      while (i < len && joined[i] !== "'") {
        token += joined[i];
        i++;
      }
      i++; // closing quote
      tokens.push(token);
    } else if (ch === '"') {
      // Double-quoted string
      i++;
      let token = '';
      while (i < len && joined[i] !== '"') {
        if (joined[i] === '\\' && i + 1 < len) {
          i++;
          token += joined[i] ?? '';
        } else {
          token += joined[i] ?? '';
        }
        i++;
      }
      i++; // closing quote
      tokens.push(token);
    } else if (ch === '$' && joined[i + 1] === "'") {
      // ANSI-C quoting $'...'
      i += 2;
      let token = '';
      while (i < len && joined[i] !== "'") {
        if (joined[i] === '\\' && i + 1 < len) {
          i++;
          const esc = joined[i] ?? '';
          switch (esc) {
            case 'n': token += '\n'; break;
            case 't': token += '\t'; break;
            case 'r': token += '\r'; break;
            default: token += esc;
          }
        } else {
          token += joined[i] ?? '';
        }
        i++;
      }
      i++;
      tokens.push(token);
    } else {
      // Unquoted token (read until whitespace)
      let token = '';
      while (i < len && !/\s/.test(joined[i] ?? '')) {
        token += joined[i];
        i++;
      }
      if (token !== '') tokens.push(token);
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a cURL command string into an `HttpRequestDef`.
 *
 * @returns The parsed request definition, or `null` if the input cannot be
 *          parsed as a valid cURL command (e.g. no URL found).
 */
export function parseCurl(curlCommand: string): HttpRequestDef | null {
  const tokens = tokenize(curlCommand.trim());

  if (tokens.length === 0) return null;

  // First token should be "curl" (possibly with full path)
  const first = tokens[0] ?? '';
  const startIdx = /\bcurl$/.test(first) ? 1 : 0;
  const args = tokens.slice(startIdx);

  let method: HttpMethod = 'GET';
  let url = '';
  const headers: Record<string, string> = {};
  const bodyParts: string[] = [];
  let bodyType: 'json' | 'text' | 'form-data' = 'text';
  let sslVerify = true;

  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';

    // ------------------------------------------------------------------
    // Method flags
    // ------------------------------------------------------------------
    if (arg === '-X' || arg === '--request') {
      const val = args[++i] ?? '';
      const upper = val.toUpperCase() as HttpMethod;
      const valid: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
      if (valid.includes(upper)) method = upper;
      i++;
      continue;
    }

    // Combined form: -XPOST
    if (/^-X(\w+)$/.test(arg)) {
      const m = /^-X(\w+)$/.exec(arg);
      if (m) {
        const upper = (m[1] ?? '').toUpperCase() as HttpMethod;
        const valid: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        if (valid.includes(upper)) method = upper;
      }
      i++;
      continue;
    }

    // ------------------------------------------------------------------
    // Header flags
    // ------------------------------------------------------------------
    if (arg === '-H' || arg === '--header') {
      const val = args[++i] ?? '';
      const colon = val.indexOf(':');
      if (colon !== -1) {
        const key = val.slice(0, colon).trim();
        const value = val.slice(colon + 1).trim();
        if (key) headers[key] = value;
      }
      i++;
      continue;
    }

    // ------------------------------------------------------------------
    // Body flags
    // ------------------------------------------------------------------
    if (arg === '-d' || arg === '--data' || arg === '--data-raw' || arg === '--data-ascii') {
      const val = args[++i] ?? '';
      bodyParts.push(val);
      // Detect JSON body heuristically
      const trimmed = val.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        bodyType = 'json';
      }
      i++;
      continue;
    }

    if (arg === '--data-urlencode') {
      const val = args[++i] ?? '';
      bodyParts.push(val);
      bodyType = 'form-data';
      i++;
      continue;
    }

    if (arg === '--data-binary') {
      const val = args[++i] ?? '';
      bodyParts.push(val);
      i++;
      continue;
    }

    // ------------------------------------------------------------------
    // Basic auth flag
    // ------------------------------------------------------------------
    if (arg === '-u' || arg === '--user') {
      const val = args[++i] ?? '';
      const encoded = Buffer.from(val).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      i++;
      continue;
    }

    // ------------------------------------------------------------------
    // SSL flags
    // ------------------------------------------------------------------
    if (arg === '-k' || arg === '--insecure') {
      sslVerify = false;
      i++;
      continue;
    }

    // ------------------------------------------------------------------
    // Flags to skip (with optional value argument)
    // ------------------------------------------------------------------
    if ([
      '--compressed', '--silent', '-s', '--verbose', '-v',
      '--location', '-L', '--max-time', '--connect-timeout',
      '-o', '--output', '-A', '--user-agent', '--cookie', '-b',
      '--cookie-jar', '-c', '--proxy', '--cacert', '--cert',
    ].includes(arg)) {
      // Some of these consume a value token, some don't
      const consumesValue = [
        '-o', '--output', '-A', '--user-agent', '--cookie', '-b',
        '--cookie-jar', '-c', '--proxy', '--cacert', '--cert',
        '--max-time', '--connect-timeout',
      ];
      if (consumesValue.includes(arg)) i++;
      i++;
      continue;
    }

    // ------------------------------------------------------------------
    // URL — any non-flag argument is treated as the URL
    // ------------------------------------------------------------------
    if (!arg.startsWith('-') && url === '') {
      url = arg;
      i++;
      continue;
    }

    i++;
  }

  if (!url) return null;

  // ------------------------------------------------------------------
  // Build the body
  // ------------------------------------------------------------------
  let body: RequestBody | undefined;
  if (bodyParts.length > 0) {
    const combined = bodyParts.join('&');
    if (bodyType === 'form-data') {
      body = { type: 'form-data', content: combined };
    } else if (bodyType === 'json') {
      body = { type: 'json', content: combined };
    } else {
      body = { type: 'text', content: combined };
    }
    // Infer method: if body provided and method is still GET, upgrade to POST
    if (method === 'GET') method = 'POST';
  }

  // ------------------------------------------------------------------
  // Build the request def
  // ------------------------------------------------------------------
  const id = `curl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  return {
    id,
    name: `Imported from cURL`,
    method,
    url,
    headers,
    queryParams: [],
    ...(body !== undefined ? { body } : {}),
    ...(sslVerify === false ? { settings: { sslVerify: false } } : {}),
  };
}
