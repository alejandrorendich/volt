/**
 * @fileoverview Code generation utility — converts an HttpRequestDef to
 * runnable code snippets in multiple languages.
 *
 * Supported languages:
 *   - curl        — cURL command
 *   - fetch       — JavaScript (fetch)
 *   - axios       — JavaScript (axios)
 *   - python      — Python (requests library)
 *   - node        — Node.js (http/https module)
 *   - php         — PHP (cURL)
 */

import type { HttpRequestDef } from '../../shared/models';

export type CodegenLanguage = 'curl' | 'fetch' | 'axios' | 'python' | 'node' | 'php';

export const CODEGEN_LANGUAGE_LABELS: Record<CodegenLanguage, string> = {
  curl: 'cURL',
  fetch: 'JavaScript (fetch)',
  axios: 'JavaScript (axios)',
  python: 'Python (requests)',
  node: 'Node.js (http)',
  php: 'PHP (cURL)',
};

/**
 * Generate runnable code from an HttpRequestDef for the given language.
 * Auth headers are always included when auth is configured.
 */
export function generateCode(request: HttpRequestDef, language: CodegenLanguage): string {
  // Resolve auth into request headers for code generation
  const requestWithAuth = injectAuthHeaders(request);

  switch (language) {
    case 'curl':   return generateCurl(requestWithAuth);
    case 'fetch':  return generateFetch(requestWithAuth);
    case 'axios':  return generateAxios(requestWithAuth);
    case 'python': return generatePython(requestWithAuth);
    case 'node':   return generateNode(requestWithAuth);
    case 'php':    return generatePhp(requestWithAuth);
    default:       return '// Unsupported language';
  }
}

// ---------------------------------------------------------------------------
// Auth injection
// ---------------------------------------------------------------------------

function injectAuthHeaders(request: HttpRequestDef): HttpRequestDef {
  if (!request.auth || request.auth.type === 'none') return request;

  const extraHeaders: Record<string, string> = {};

  if (request.auth.type === 'bearer') {
    extraHeaders['Authorization'] = `Bearer ${request.auth.token}`;
  } else if (request.auth.type === 'basic') {
    const encoded = btoa(`${request.auth.username}:${request.auth.password}`);
    extraHeaders['Authorization'] = `Basic ${encoded}`;
  } else if (request.auth.type === 'apikey' && request.auth.addTo === 'header') {
    extraHeaders[request.auth.key] = request.auth.value;
  }

  return {
    ...request,
    headers: { ...request.headers, ...extraHeaders },
  };
}

// ---------------------------------------------------------------------------
// cURL
// ---------------------------------------------------------------------------

function escapeShellArg(s: string): string {
  // Single-quote for Unix shell; internal single-quotes escaped as '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function generateCurl(req: HttpRequestDef): string {
  const parts: string[] = ['curl'];

  if (req.method !== 'GET') {
    parts.push(`-X ${req.method}`);
  }

  for (const [key, value] of Object.entries(req.headers)) {
    parts.push(`-H ${escapeShellArg(`${key}: ${value}`)}`);
  }

  if (req.body && req.body.type !== 'none') {
    if (req.body.type === 'json') {
      if (!hasHeader(req, 'content-type')) {
        parts.push(`-H ${escapeShellArg('Content-Type: application/json')}`);
      }
      parts.push(`-d ${escapeShellArg(req.body.content)}`);
    } else if (req.body.type === 'text') {
      parts.push(`-d ${escapeShellArg(req.body.content)}`);
    } else if (req.body.type === 'form-data') {
      const pairs = req.body.content.split('\n').filter(Boolean);
      for (const pair of pairs) {
        parts.push(`--data-urlencode ${escapeShellArg(pair)}`);
      }
    } else if (req.body.type === 'graphql') {
      if (!hasHeader(req, 'content-type')) {
        parts.push(`-H ${escapeShellArg('Content-Type: application/json')}`);
      }
      parts.push(`-d ${escapeShellArg(serializeGraphqlBody(req.body.query, req.body.variables, req.body.operationName))}`);
    }
  }

  parts.push(escapeShellArg(req.url));

  return parts.join(' \\\n  ');
}

// ---------------------------------------------------------------------------
// JavaScript fetch
// ---------------------------------------------------------------------------

function generateFetch(req: HttpRequestDef): string {
  const lines: string[] = [];

  lines.push(`const response = await fetch(${JSON.stringify(req.url)}, {`);
  lines.push(`  method: ${JSON.stringify(req.method)},`);

  const headerEntries = Object.entries(req.headers);
  if (headerEntries.length > 0) {
    lines.push('  headers: {');
    for (const [k, v] of headerEntries) {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    }
    lines.push('  },');
  }

  const bodyStr = buildBodyString(req);
  if (bodyStr !== null) {
    lines.push(`  body: ${bodyStr},`);
  }

  lines.push('});');
  lines.push('');
  lines.push('const data = await response.json();');
  lines.push('console.log(data);');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JavaScript axios
// ---------------------------------------------------------------------------

function generateAxios(req: HttpRequestDef): string {
  const lines: string[] = [];

  lines.push(`const response = await axios({`);
  lines.push(`  method: ${JSON.stringify(req.method.toLowerCase())},`);
  lines.push(`  url: ${JSON.stringify(req.url)},`);

  const headerEntries = Object.entries(req.headers);
  if (headerEntries.length > 0) {
    lines.push('  headers: {');
    for (const [k, v] of headerEntries) {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    }
    lines.push('  },');
  }

  if (req.body && req.body.type !== 'none') {
    if (req.body.type === 'json') {
      try {
        const parsed: unknown = JSON.parse(req.body.content);
        lines.push(`  data: ${JSON.stringify(parsed, null, 4).split('\n').map((l, i) => i === 0 ? l : `  ${l}`).join('\n')},`);
      } catch {
        lines.push(`  data: ${JSON.stringify(req.body.content)},`);
      }
    } else if (req.body.type === 'text') {
      lines.push(`  data: ${JSON.stringify(req.body.content)},`);
    } else if (req.body.type === 'graphql') {
      lines.push(`  data: ${serializeGraphqlBody(req.body.query, req.body.variables, req.body.operationName)},`);
    }
  }

  lines.push('});');
  lines.push('');
  lines.push('console.log(response.data);');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Python requests
// ---------------------------------------------------------------------------

function generatePython(req: HttpRequestDef): string {
  const lines: string[] = [];

  lines.push('import requests');
  lines.push('');

  const headerEntries = Object.entries(req.headers);
  if (headerEntries.length > 0) {
    lines.push('headers = {');
    for (const [k, v] of headerEntries) {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    }
    lines.push('}');
    lines.push('');
  }

  const method = req.method.toLowerCase();
  const url = JSON.stringify(req.url);
  const headersArg = headerEntries.length > 0 ? ', headers=headers' : '';

  if (req.body && req.body.type !== 'none') {
    if (req.body.type === 'json') {
      try {
        const parsed: unknown = JSON.parse(req.body.content);
        const jsonLines = JSON.stringify(parsed, null, 4).split('\n');
        lines.push(`data = ${jsonLines[0]}`);
        for (const l of jsonLines.slice(1)) lines.push(l);
        lines.push('');
        lines.push(`response = requests.${method}(${url}${headersArg}, json=data)`);
      } catch {
        lines.push(`response = requests.${method}(${url}${headersArg}, data=${JSON.stringify(req.body.content)})`);
      }
    } else if (req.body.type === 'text') {
      lines.push(`response = requests.${method}(${url}${headersArg}, data=${JSON.stringify(req.body.content)})`);
    } else if (req.body.type === 'form-data') {
      lines.push('form_data = {');
      for (const pair of req.body.content.split('\n').filter(Boolean)) {
        const eqIdx = pair.indexOf('=');
        const k = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
        const v = eqIdx === -1 ? '' : pair.slice(eqIdx + 1);
        lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
      }
      lines.push('}');
      lines.push('');
      lines.push(`response = requests.${method}(${url}${headersArg}, data=form_data)`);
    } else if (req.body.type === 'graphql') {
      lines.push('payload = {');
      lines.push(`    'query': ${JSON.stringify(req.body.query)},`);
      if (req.body.variables.trim()) {
        lines.push(`    'variables': ${req.body.variables.trim()},`);
      }
      if (req.body.operationName) {
        lines.push(`    'operationName': ${JSON.stringify(req.body.operationName)},`);
      }
      lines.push('}');
      lines.push('');
      lines.push(`response = requests.${method}(${url}${headersArg}, json=payload)`);
    } else {
      lines.push(`response = requests.${method}(${url}${headersArg})`);
    }
  } else {
    lines.push(`response = requests.${method}(${url}${headersArg})`);
  }

  lines.push('');
  lines.push('print(response.status_code)');
  lines.push('print(response.json())');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Node.js http/https
// ---------------------------------------------------------------------------

function generateNode(req: HttpRequestDef): string {
  const lines: string[] = [];

  let parsedUrl: URL | null = null;
  try { parsedUrl = new URL(req.url); } catch { /* ignore */ }

  const isHttps = parsedUrl?.protocol === 'https:';
  lines.push(`const ${isHttps ? 'https' : 'http'} = require('${isHttps ? 'https' : 'http'}');`);
  lines.push('');

  const body = getBodyString(req);

  const headerEntries = Object.entries(req.headers);
  const allHeaders: Record<string, string> = { ...Object.fromEntries(headerEntries) };
  if (body) {
    allHeaders['Content-Length'] = String(new TextEncoder().encode(body).byteLength);
  }

  lines.push('const options = {');
  lines.push(`  hostname: ${JSON.stringify(parsedUrl?.hostname ?? req.url)},`);
  if (parsedUrl?.port) lines.push(`  port: ${parsedUrl.port},`);
  lines.push(`  path: ${JSON.stringify((parsedUrl?.pathname ?? '/') + (parsedUrl?.search ?? ''))},`);
  lines.push(`  method: ${JSON.stringify(req.method)},`);
  if (Object.keys(allHeaders).length > 0) {
    lines.push('  headers: {');
    for (const [k, v] of Object.entries(allHeaders)) {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    }
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push(`const req = ${isHttps ? 'https' : 'http'}.request(options, (res) => {`);
  lines.push("  let data = '';");
  lines.push("  res.on('data', (chunk) => { data += chunk; });");
  lines.push("  res.on('end', () => { console.log(JSON.parse(data)); });");
  lines.push('});');
  lines.push('');
  lines.push("req.on('error', console.error);");

  if (body) {
    lines.push(`req.write(${JSON.stringify(body)});`);
  }

  lines.push('req.end();');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PHP cURL
// ---------------------------------------------------------------------------

function generatePhp(req: HttpRequestDef): string {
  const lines: string[] = [];

  lines.push('<?php');
  lines.push('');
  lines.push('$ch = curl_init();');
  lines.push('');
  lines.push(`curl_setopt($ch, CURLOPT_URL, ${phpStr(req.url)});`);
  lines.push('curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);');

  if (req.method !== 'GET') {
    lines.push(`curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpStr(req.method)});`);
  }

  const headerEntries = Object.entries(req.headers);
  if (headerEntries.length > 0) {
    lines.push('curl_setopt($ch, CURLOPT_HTTPHEADER, [');
    for (const [k, v] of headerEntries) {
      lines.push(`  ${phpStr(`${k}: ${v}`)},`);
    }
    lines.push(']);');
  }

  const body = getBodyString(req);
  if (body) {
    lines.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, ${phpStr(body)});`);
  }

  lines.push('');
  lines.push('$response = curl_exec($ch);');
  lines.push('$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);');
  lines.push('curl_close($ch);');
  lines.push('');
  lines.push('echo $httpCode . PHP_EOL;');
  lines.push('echo $response . PHP_EOL;');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hasHeader(req: HttpRequestDef, name: string): boolean {
  return Object.keys(req.headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

/** Get the body as a serialized string, or null if no body. */
function getBodyString(req: HttpRequestDef): string | null {
  if (!req.body || req.body.type === 'none') return null;
  if (req.body.type === 'json' || req.body.type === 'text') return req.body.content;
  if (req.body.type === 'form-data') return req.body.content;
  if (req.body.type === 'graphql') return serializeGraphqlBody(req.body.query, req.body.variables, req.body.operationName);
  return null;
}

/** Build the body as a JS expression string for fetch. */
function buildBodyString(req: HttpRequestDef): string | null {
  if (!req.body || req.body.type === 'none') return null;
  if (req.body.type === 'json') return `JSON.stringify(${req.body.content.trim() || '{}'})`;
  if (req.body.type === 'text') return JSON.stringify(req.body.content);
  if (req.body.type === 'form-data') {
    const pairs = req.body.content.split('\n').filter(Boolean);
    const encoded = pairs.map((p) => {
      const eqIdx = p.indexOf('=');
      const k = eqIdx === -1 ? p : p.slice(0, eqIdx);
      const v = eqIdx === -1 ? '' : p.slice(eqIdx + 1);
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }).join('&');
    return JSON.stringify(encoded);
  }
  if (req.body.type === 'graphql') {
    const json = serializeGraphqlBody(req.body.query, req.body.variables, req.body.operationName);
    return JSON.stringify(json);
  }
  return null;
}

/** Wrap a string in PHP double-quoted syntax. */
function phpStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Serialize a GraphQL body into a JSON string payload.
 * Variables field is parsed if it contains valid JSON; omitted if empty.
 * OperationName is omitted if empty.
 */
function serializeGraphqlBody(query: string, variables: string, operationName: string): string {
  const payload: Record<string, unknown> = { query };
  if (variables.trim()) {
    try {
      payload['variables'] = JSON.parse(variables) as unknown;
    } catch {
      // Invalid JSON — include as raw string so the user can see it
      payload['variables'] = variables;
    }
  }
  if (operationName) payload['operationName'] = operationName;
  return JSON.stringify(payload);
}
