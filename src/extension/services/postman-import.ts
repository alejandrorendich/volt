/**
 * @fileoverview Postman Collection v2.1 importer for Volt.
 *
 * Converts a Postman exported JSON (schema v2.1.0) into Volt's `.volt/`
 * directory structure.  The importer is intentionally defensive: malformed
 * items produce a warning and are skipped rather than crashing the whole
 * import.
 *
 * Variable syntax `{{var}}` is the same in both Postman and Volt, so no
 * translation is needed there.
 *
 * Script translations (best-effort regex):
 *   pm.environment.set("k", v) → env.set("k", v)
 *   pm.environment.get("k")    → env.get("k")
 *   pm.response.json()         → json
 *   pm.response.code           → response.status
 */

import * as fs from 'fs';
import type { CollectionService } from './collection-service';
import type { EnvironmentService } from './environment-service';
import type { HttpRequestDef, HttpMethod, QueryParam, RequestBody } from '../../shared/models';
import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface PostmanImportResult {
  readonly requests: number;
  readonly folders: number;
  readonly variables: number;
}

// ---------------------------------------------------------------------------
// Postman v2.1 JSON shapes (all unknown → type-guarded at runtime)
// ---------------------------------------------------------------------------

/** Raw Postman collection root (after JSON.parse). */
interface PostmanCollection {
  readonly info?: unknown;
  readonly item?: unknown;
  readonly variable?: unknown;
}

interface PostmanInfo {
  readonly name?: unknown;
  readonly schema?: unknown;
}

interface PostmanItem {
  readonly name?: unknown;
  readonly request?: unknown;
  readonly item?: unknown;
  readonly event?: unknown;
}

interface PostmanRequest {
  readonly method?: unknown;
  readonly header?: unknown;
  readonly body?: unknown;
  readonly url?: unknown;
}

interface PostmanHeader {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly disabled?: unknown;
}

interface PostmanBody {
  readonly mode?: unknown;
  readonly raw?: unknown;
  readonly formdata?: unknown;
  readonly options?: unknown;
}

interface PostmanBodyOptions {
  readonly raw?: unknown;
}

interface PostmanBodyRawOptions {
  readonly language?: unknown;
}

interface PostmanUrl {
  readonly raw?: unknown;
  readonly query?: unknown;
}

interface PostmanQueryParam {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly disabled?: unknown;
}

interface PostmanEvent {
  readonly listen?: unknown;
  readonly script?: unknown;
}

interface PostmanScript {
  readonly exec?: unknown;
}

interface PostmanVariable {
  readonly key?: unknown;
  readonly value?: unknown;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asPostmanCollection(v: unknown): PostmanCollection | undefined {
  return isObject(v) ? (v as PostmanCollection) : undefined;
}

function asPostmanInfo(v: unknown): PostmanInfo | undefined {
  return isObject(v) ? (v as PostmanInfo) : undefined;
}

function asPostmanItem(v: unknown): PostmanItem | undefined {
  return isObject(v) ? (v as PostmanItem) : undefined;
}

function asPostmanRequest(v: unknown): PostmanRequest | undefined {
  return isObject(v) ? (v as PostmanRequest) : undefined;
}

function asPostmanBody(v: unknown): PostmanBody | undefined {
  return isObject(v) ? (v as PostmanBody) : undefined;
}

function asPostmanBodyOptions(v: unknown): PostmanBodyOptions | undefined {
  return isObject(v) ? (v as PostmanBodyOptions) : undefined;
}

function asPostmanBodyRawOptions(v: unknown): PostmanBodyRawOptions | undefined {
  return isObject(v) ? (v as PostmanBodyRawOptions) : undefined;
}

function asPostmanUrl(v: unknown): PostmanUrl | undefined {
  return isObject(v) ? (v as PostmanUrl) : undefined;
}

function asPostmanEvent(v: unknown): PostmanEvent | undefined {
  return isObject(v) ? (v as PostmanEvent) : undefined;
}

function asPostmanScript(v: unknown): PostmanScript | undefined {
  return isObject(v) ? (v as PostmanScript) : undefined;
}

function asPostmanVariable(v: unknown): PostmanVariable | undefined {
  return isObject(v) ? (v as PostmanVariable) : undefined;
}

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

const VALID_NAME_RE = /[^a-zA-Z0-9_-]/g;
const MAX_NAME_LEN = 50;

/**
 * Convert an arbitrary Postman item name into a filesystem-safe slug:
 * - Lower-case
 * - Spaces → hyphens
 * - Characters outside [a-zA-Z0-9_-] removed
 * - Truncated to 50 chars
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(VALID_NAME_RE, '')
    .slice(0, MAX_NAME_LEN) || 'unnamed';
}

/**
 * Resolve a name collision by appending `-1`, `-2`, etc. until unique.
 * `usedNames` is mutated to record the new reservation.
 */
function uniqueName(base: string, usedNames: Set<string>): string {
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  let counter = 1;
  let candidate = `${base}-${counter}`;
  while (usedNames.has(candidate)) {
    counter++;
    candidate = `${base}-${counter}`;
  }
  usedNames.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Script conversion (best-effort regex replacements)
// ---------------------------------------------------------------------------

const SCRIPT_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/pm\.environment\.set\(/g, 'env.set('],
  [/pm\.environment\.get\(/g, 'env.get('],
  [/pm\.response\.json\(\)/g, 'json'],
  [/pm\.response\.code/g, 'response.status'],
];

function convertScript(lines: string[]): string {
  let script = lines.join('\n');
  for (const [pattern, replacement] of SCRIPT_REPLACEMENTS) {
    script = script.replace(pattern, replacement);
  }
  return script;
}

// ---------------------------------------------------------------------------
// HTTP method validation
// ---------------------------------------------------------------------------

const VALID_METHODS: ReadonlySet<string> = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

function toHttpMethod(raw: unknown): HttpMethod {
  const s = asString(raw)?.toUpperCase();
  if (s && VALID_METHODS.has(s)) return s as HttpMethod;
  return 'GET';
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function convertHeaders(rawHeaders: unknown): Record<string, string> {
  if (!isArray(rawHeaders)) return {};
  const result: Record<string, string> = {};
  for (const h of rawHeaders) {
    const header = isObject(h) ? (h as PostmanHeader) : undefined;
    if (!header) continue;
    // Skip disabled headers
    if (header.disabled === true) continue;
    const key = asString(header.key);
    const value = asString(header.value);
    if (key && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function convertBody(rawBody: unknown): RequestBody | undefined {
  const body = asPostmanBody(rawBody);
  if (!body) return undefined;

  const mode = asString(body.mode);

  if (mode === 'raw') {
    const raw = asString(body.raw) ?? '';
    // Check if language is json
    const options = asPostmanBodyOptions(body.options);
    const rawOpts = asPostmanBodyRawOptions(options?.raw);
    const language = asString(rawOpts?.language);
    if (language === 'json') {
      return { type: 'json', content: raw };
    }
    return { type: 'text', content: raw };
  }

  if (mode === 'formdata') {
    if (!isArray(body.formdata)) return { type: 'form-data', content: '' };
    const pairs: string[] = [];
    for (const entry of body.formdata) {
      if (!isObject(entry)) continue;
      const k = asString((entry as Record<string, unknown>)['key']);
      const v = asString((entry as Record<string, unknown>)['value']);
      if (k !== undefined) {
        pairs.push(`${k}=${v ?? ''}`);
      }
    }
    return { type: 'form-data', content: pairs.join('\n') };
  }

  return undefined;
}

function convertQueryParams(rawUrl: unknown): QueryParam[] {
  const url = asPostmanUrl(rawUrl);
  if (!url || !isArray(url.query)) return [];

  const result: QueryParam[] = [];
  for (const q of url.query) {
    const param = isObject(q) ? (q as PostmanQueryParam) : undefined;
    if (!param) continue;
    const key = asString(param.key) ?? '';
    const value = asString(param.value) ?? '';
    const enabled = param.disabled !== true;
    result.push({ key, value, enabled });
  }
  return result;
}

function extractRawUrl(rawUrl: unknown): string {
  if (typeof rawUrl === 'string') return rawUrl;
  const url = asPostmanUrl(rawUrl);
  return asString(url?.raw) ?? '';
}

function extractScripts(rawEvents: unknown): { preScript?: string; postScript?: string } {
  if (!isArray(rawEvents)) return {};
  let preScript: string | undefined;
  let postScript: string | undefined;

  for (const e of rawEvents) {
    const event = asPostmanEvent(e);
    if (!event) continue;
    const listen = asString(event.listen);
    const script = asPostmanScript(event.script);
    if (!script || !isArray(script.exec)) continue;

    const lines = script.exec
      .map((line) => asString(line) ?? '')
      .filter((line) => line.length > 0);

    if (lines.length === 0) continue;
    const converted = convertScript(lines);

    if (listen === 'prerequest') {
      preScript = converted;
    } else if (listen === 'test') {
      postScript = converted;
    }
  }

  return {
    ...(preScript !== undefined ? { preScript } : {}),
    ...(postScript !== undefined ? { postScript } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core walker
// ---------------------------------------------------------------------------

interface WalkContext {
  readonly collectionService: CollectionService;
  readonly output: vscode.OutputChannel;
  readonly usedNames: Set<string>;
  requestCount: number;
  folderCount: number;
}

async function walkItems(
  items: unknown[],
  folderPrefix: string,
  ctx: WalkContext,
): Promise<void> {
  for (const rawItem of items) {
    const item = asPostmanItem(rawItem);
    if (!item) {
      ctx.output.appendLine('[PostmanImport] WARNING: skipping non-object item');
      continue;
    }

    const displayName = asString(item.name) ?? 'unnamed';

    // Folder: has nested item[]
    if (isArray(item.item)) {
      const folderSlug = sanitizeName(displayName);
      const folderPath = folderPrefix
        ? `${folderPrefix}/${folderSlug}`
        : folderSlug;

      try {
        await ctx.collectionService.createFolder(folderPath);
        ctx.folderCount++;
        ctx.output.appendLine(`[PostmanImport] Created folder: ${folderPath}`);
      } catch (err: unknown) {
        ctx.output.appendLine(
          `[PostmanImport] WARNING: could not create folder "${folderPath}" — ${String(err)}`,
        );
      }

      await walkItems(item.item, folderPath, ctx);
      continue;
    }

    // Request: has request object
    if (!isObject(item.request)) {
      ctx.output.appendLine(
        `[PostmanImport] WARNING: item "${displayName}" has neither request nor item[] — skipping`,
      );
      continue;
    }

    const req = asPostmanRequest(item.request);
    if (!req) continue;

    const slug = sanitizeName(displayName);
    const nameKey = folderPrefix ? `${folderPrefix}/${slug}` : slug;
    const uniqueSlug = uniqueName(slug, ctx.usedNames);
    const relPath = folderPrefix ? `${folderPrefix}/${uniqueSlug}` : uniqueSlug;

    try {
      const scripts = extractScripts(item.event);
      const queryParams = convertQueryParams(req.url);
      const body = convertBody(req.body);

      const requestDef: HttpRequestDef = {
        id: relPath,
        name: displayName,
        method: toHttpMethod(req.method),
        url: extractRawUrl(req.url),
        headers: convertHeaders(req.header),
        queryParams,
        ...(body !== undefined ? { body } : {}),
        ...('preScript' in scripts && scripts.preScript !== undefined
          ? { preScript: scripts.preScript }
          : {}),
        ...('postScript' in scripts && scripts.postScript !== undefined
          ? { postScript: scripts.postScript }
          : {}),
      };

      await ctx.collectionService.saveRequest(relPath, requestDef);
      ctx.requestCount++;
      ctx.output.appendLine(`[PostmanImport] Saved request: ${relPath}`);
    } catch (err: unknown) {
      ctx.output.appendLine(
        `[PostmanImport] WARNING: could not save request "${nameKey}" — ${String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import a Postman v2.1 collection JSON file into Volt.
 *
 * @param filePath           - Absolute path to the Postman `.json` export.
 * @param collectionService  - Volt collection service (must be initialised).
 * @param environmentService - Volt environment service (used to save variables).
 * @param output             - VS Code output channel for progress/warnings.
 * @returns Counts of imported requests, folders, and variables.
 */
export async function importPostmanCollection(
  filePath: string,
  collectionService: CollectionService,
  environmentService: EnvironmentService,
  output: vscode.OutputChannel,
): Promise<PostmanImportResult> {
  output.appendLine(`[PostmanImport] Reading: ${filePath}`);

  // Read and parse
  let raw: unknown;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    raw = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    throw new Error(`Failed to read or parse Postman file: ${String(err)}`);
  }

  const collection = asPostmanCollection(raw);
  if (!collection) {
    throw new Error('File is not a valid Postman collection (expected a JSON object).');
  }

  // Validate v2.1 schema
  const info = asPostmanInfo(collection.info);
  const schema = asString(info?.schema) ?? '';
  if (!schema.includes('v2.1')) {
    throw new Error(
      `Unsupported Postman schema: "${schema}". Only v2.1 collections are supported.`,
    );
  }

  const collectionName = asString(info?.name) ?? 'Postman Import';
  output.appendLine(`[PostmanImport] Importing collection: "${collectionName}" (schema: ${schema})`);

  const items = isArray(collection.item) ? collection.item : [];

  const ctx: WalkContext = {
    collectionService,
    output,
    usedNames: new Set<string>(),
    requestCount: 0,
    folderCount: 0,
  };

  await walkItems(items, '', ctx);

  // Import collection-level variables as a "postman" environment
  let variableCount = 0;
  const rawVars = collection.variable;
  if (isArray(rawVars) && rawVars.length > 0) {
    const variables: Record<string, string> = {};
    for (const v of rawVars) {
      const variable = asPostmanVariable(v);
      if (!variable) continue;
      const key = asString(variable.key);
      const value = asString(variable.value);
      if (key) {
        variables[key] = value ?? '';
        variableCount++;
      }
    }

    if (variableCount > 0) {
      try {
        // Create the environment (may already exist — ignore if so)
        await environmentService.createEnvironment('postman');
      } catch {
        // Environment already exists — update its variables instead
        output.appendLine('[PostmanImport] "postman" environment already exists — merging variables');
      }
      try {
        // Save the previously active environment so we can restore it afterward
        const prevActive = environmentService.getActiveName();
        // Switch to "postman" temporarily so updateVariables targets it
        await environmentService.setActive('postman');
        await environmentService.updateVariables(variables);
        // Restore the previous active environment
        if (prevActive) {
          await environmentService.setActive(prevActive);
        }
        output.appendLine(`[PostmanImport] Saved ${variableCount} variable(s) to postman environment`);
      } catch (err: unknown) {
        output.appendLine(
          `[PostmanImport] WARNING: could not save variables — ${String(err)}`,
        );
      }
    }
  }

  output.appendLine(
    `[PostmanImport] Done — ${ctx.requestCount} requests, ${ctx.folderCount} folders, ${variableCount} variables`,
  );

  return {
    requests: ctx.requestCount,
    folders: ctx.folderCount,
    variables: variableCount,
  };
}
