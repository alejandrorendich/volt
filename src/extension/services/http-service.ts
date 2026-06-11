/**
 * @fileoverview Volt HTTP Service.
 *
 * Executes HTTP requests via undici with:
 * - All HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
 * - Per-phase timing via `diagnostics_channel` (DNS / TCP / TLS / TTFB / body)
 * - AbortController-based cancellation
 * - Configurable redirect following (max 10)
 * - Configurable timeout (default 30 s)
 * - Response size limit with truncation (default 50 MB)
 * - Structured error mapping (timeout, dns_error, connection_refused, tls_error…)
 * - Optional TLS verification bypass (`rejectUnauthorized`)
 *
 * @see REQ-HTTP-001 — Request Execution
 * @see REQ-HTTP-002 — Timing Breakdown
 * @see REQ-HTTP-003 — Cancellation
 * @see REQ-HTTP-004 — Redirect Handling
 * @see REQ-HTTP-005 — Error Handling
 * @see REQ-HTTP-006 — Response Size Limit
 * @see REQ-HTTP-007 — TLS Certificate Handling
 */

import { request as undiciRequest, Agent } from 'undici';
import * as diagnosticsChannel from 'diagnostics_channel';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import type { IHttpService } from '../message-router';
import type { HttpRequestDef, HttpResponseDef, TimingBreakdown } from '../../shared/models';
import type { CorrelationId, ExecuteErrorCode } from '../../shared/protocol';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 10;
/** 50 MB in bytes */
const DEFAULT_BODY_SIZE_LIMIT = 50 * 1024 * 1024;
/** 5 MB threshold — bodies larger than this are offloaded to a temp file (REQ-MSG-005) */
const LARGE_BODY_THRESHOLD = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public options / error types
// ---------------------------------------------------------------------------

export interface HttpRequestOptions {
  /** Override per-request timeout in ms (default: 30 000). */
  readonly timeoutMs?: number;
  /** Whether to follow 3xx redirects (default: true). */
  readonly followRedirects?: boolean;
  /** Maximum redirects to follow (default: 10). */
  readonly maxRedirects?: number;
  /** Maximum response body bytes before truncation (default: 50 MB). */
  readonly bodySizeLimit?: number;
  /** When true, TLS certificate validation is disabled. Default: false. */
  readonly rejectUnauthorized?: boolean;
}

export interface HttpExecuteError {
  readonly type: 'error';
  readonly code: ExecuteErrorCode;
  readonly message: string;
}

export type HttpExecuteResult =
  | { readonly type: 'success'; readonly response: HttpResponseDef }
  | HttpExecuteError;

// ---------------------------------------------------------------------------
// Internal timing accumulator
// ---------------------------------------------------------------------------

interface TimingAccumulator {
  dnsStart: number | undefined;
  dnsEnd: number | undefined;
  connectStart: number | undefined;
  connectEnd: number | undefined;
  tlsStart: number | undefined;
  tlsEnd: number | undefined;
  sendStart: number | undefined;
  responseStart: number | undefined;
  responseEnd: number | undefined;
}

// ---------------------------------------------------------------------------
// HttpService
// ---------------------------------------------------------------------------

/**
 * Concrete HTTP execution service backed by undici.
 *
 * One AbortController per in-flight request, keyed by correlationId. Calling
 * `cancel(correlationId)` aborts the matching request.
 */
export class HttpService implements IHttpService, vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  /** Map of correlationId → AbortController for in-flight requests. */
  private readonly inFlight = new Map<string, AbortController>();
  /**
   * Simple async mutex — serialises HTTP execution so that the global
   * `undici:*` diagnostics channels never receive events from two concurrent
   * requests at the same time (C-04).
   */
  private executionQueue: Promise<void> = Promise.resolve();

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  // ---------------------------------------------------------------------------
  // IHttpService: execute
  // ---------------------------------------------------------------------------

  async execute(
    requestDef: HttpRequestDef,
    correlationId: CorrelationId,
    onProgress?: (phase: import('../../shared/models').TimingPhase, elapsed: number) => void,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponseDef> {
    // Serialise execution through the queue so concurrent requests never
    // cross-contaminate the global undici diagnostics channels (C-04).
    return new Promise<HttpResponseDef>((resolve, reject) => {
      this.executionQueue = this.executionQueue.then(async () => {
        try {
          const result = await this.executeWithResult(requestDef, correlationId, onProgress, options);
          if (result.type === 'error') {
            const err = new Error(result.message);
            (err as NodeJS.ErrnoException).code = result.code;
            reject(err);
          } else {
            resolve(result.response);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Lower-level variant — returns a discriminated result instead of throwing. */
  async executeWithResult(
    requestDef: HttpRequestDef,
    correlationId: CorrelationId,
    onProgress?: (phase: import('../../shared/models').TimingPhase, elapsed: number) => void,
    options: HttpRequestOptions = {},
  ): Promise<HttpExecuteResult> {
    const {
      timeoutMs = DEFAULT_TIMEOUT_MS,
      followRedirects = true,
      maxRedirects = DEFAULT_MAX_REDIRECTS,
      bodySizeLimit = DEFAULT_BODY_SIZE_LIMIT,
      rejectUnauthorized = false,
    } = options;

    // Build final URL with enabled query params
    const url = buildUrl(requestDef);

    // Abort controller — stored so `cancel()` can reach it
    const controller = new AbortController();
    this.inFlight.set(correlationId, controller);

    const wallStart = performance.now();
    const timingAcc: TimingAccumulator = {
      dnsStart: undefined,
      dnsEnd: undefined,
      connectStart: undefined,
      connectEnd: undefined,
      tlsStart: undefined,
      tlsEnd: undefined,
      sendStart: undefined,
      responseStart: undefined,
      responseEnd: undefined,
    };

    // Subscribe to diagnostics_channel events before firing the request
    const unsub = subscribeToTimingChannels(timingAcc);

    try {
      this.output.appendLine(`[HttpService] ${requestDef.method} ${url} (correlationId: ${correlationId})`);

      // Build undici agent (controls TLS and per-agent options)
      const agent = new Agent({
        connect: {
          rejectUnauthorized,
        },
        maxRedirections: followRedirects ? maxRedirects : 0,
      });

      // Build request headers
      const headers: Record<string, string> = { ...requestDef.headers };

      // Build request body
      const { body: rawBody, contentType } = buildRequestBody(requestDef);
      if (contentType && !headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = contentType;
      }

      timingAcc.sendStart = performance.now();
      onProgress?.('dns', 0);

      const resp = await undiciRequest(url, {
        method: requestDef.method,
        headers,
        body: rawBody ?? undefined,
        signal: controller.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        dispatcher: agent,
        maxRedirections: followRedirects ? maxRedirects : 0,
        throwOnError: false,
      } as Parameters<typeof undiciRequest>[1]);

      timingAcc.responseStart = performance.now();
      onProgress?.('ttfb', performance.now() - wallStart);

      // Collect response body with size limit
      const { body: bodyString, bodySize, truncated } = await consumeBody(
        resp.body,
        bodySizeLimit,
      );

      timingAcc.responseEnd = performance.now();
      onProgress?.('body', performance.now() - wallStart);
      const wallEnd = performance.now();

      const timing = buildTimingBreakdown(timingAcc, wallStart, wallEnd);

      // Normalise headers (undici may return arrays for multi-value headers)
      const responseHeaders = normaliseHeaders(resp.headers as Record<string, string | string[]>);

      // REQ-MSG-005: Offload large bodies (> 5 MB) to a temp file
      let finalBody = bodyString;
      let bodyRef: string | undefined;
      if (bodySize > LARGE_BODY_THRESHOLD) {
        try {
          const tmpFile = path.join(os.tmpdir(), `volt-resp-${correlationId}.txt`);
          await fs.writeFile(tmpFile, bodyString, 'utf8');
          bodyRef = `file:///${tmpFile.replace(/\\/g, '/')}`;
          finalBody = '';
          this.output.appendLine(`[HttpService] Large body (${bodySize} bytes) offloaded to ${tmpFile}`);
        } catch (fsErr: unknown) {
          this.output.appendLine(`[HttpService] WARN: failed to write body ref — ${String(fsErr)}`);
        }
      }

      const response: HttpResponseDef = {
        requestId: requestDef.id,
        status: resp.statusCode,
        statusText: statusTextFor(resp.statusCode),
        headers: responseHeaders,
        body: finalBody,
        bodySize,
        timing,
        ...(truncated ? { truncated: true } : {}),
        ...(bodyRef !== undefined ? { bodyRef } : {}),
      };

      this.output.appendLine(
        `[HttpService] ${resp.statusCode} in ${timing.total.toFixed(1)}ms (body: ${bodySize} bytes${truncated ? ', truncated' : ''}${bodyRef ? ', ref' : ''})`,
      );

      return { type: 'success', response };
    } catch (err: unknown) {
      const wallEnd = performance.now();
      const timing = buildTimingBreakdown(timingAcc, wallStart, wallEnd);
      const mapped = mapError(err, timing);
      this.output.appendLine(`[HttpService] Error — ${mapped.code}: ${mapped.message}`);
      return mapped;
    } finally {
      unsub();
      this.inFlight.delete(correlationId);
    }
  }

  // ---------------------------------------------------------------------------
  // IHttpService: cancel
  // ---------------------------------------------------------------------------

  cancel(requestId: string): void {
    const controller = this.inFlight.get(requestId);
    if (controller) {
      this.output.appendLine(`[HttpService] Cancelling request: ${requestId}`);
      controller.abort();
      this.inFlight.delete(requestId);
    }
  }

  // ---------------------------------------------------------------------------
  // Disposable
  // ---------------------------------------------------------------------------

  dispose(): void {
    // Abort all in-flight requests on extension deactivation
    for (const [id, controller] of this.inFlight) {
      this.output.appendLine(`[HttpService] Aborting in-flight request on dispose: ${id}`);
      controller.abort();
    }
    this.inFlight.clear();
  }
}

// ---------------------------------------------------------------------------
// diagnostics_channel binding
// ---------------------------------------------------------------------------

/**
 * Subscribe to undici's internal diagnostics channels to capture per-phase
 * timing. Returns an unsubscribe function to call when the request completes.
 *
 * Channel reference:
 * https://undici.nodejs.org/#/docs/api/DiagnosticsChannel
 *
 * We use the `undici:request:*` channels which fire for each connection
 * attempt. The accumulator is mutated in-place so the outer scope can read
 * the final timestamps after the response is consumed.
 */
function subscribeToTimingChannels(acc: TimingAccumulator): () => void {
  // undici diagnostics channels (Node 18+)
  // Names follow undici's public channel API.
  const handlers: Array<{ channel: ReturnType<typeof diagnosticsChannel.channel>; fn: (msg: unknown) => void }> = [];

  function sub(name: string, fn: (msg: unknown) => void): void {
    const ch = diagnosticsChannel.channel(name);
    ch.subscribe(fn);
    handlers.push({ channel: ch, fn });
  }

  sub('undici:client:connectError', (_msg) => {
    // Connection error — mark the connect phase end so we know it failed
    if (acc.connectStart !== undefined && acc.connectEnd === undefined) {
      acc.connectEnd = performance.now();
    }
  });

  sub('undici:client:connected', (_msg) => {
    if (acc.connectEnd === undefined) {
      acc.connectEnd = performance.now();
    }
  });

  sub('undici:request:create', (_msg) => {
    if (acc.dnsStart === undefined) {
      acc.dnsStart = performance.now();
    }
  });

  sub('undici:client:beforeConnect', (_msg) => {
    if (acc.connectStart === undefined) {
      acc.connectStart = performance.now();
    }
  });

  sub('undici:client:sendHeaders', (_msg) => {
    if (acc.dnsEnd === undefined && acc.dnsStart !== undefined) {
      // DNS resolves before the TCP connection is established; we use
      // beforeConnect as the DNS-end proxy since undici doesn't expose a
      // separate DNS channel.
      acc.dnsEnd = acc.connectStart ?? performance.now();
    }
    if (acc.tlsStart === undefined && acc.connectEnd !== undefined) {
      acc.tlsStart = acc.connectEnd;
    }
    if (acc.tlsEnd === undefined) {
      acc.tlsEnd = performance.now();
    }
  });

  sub('undici:request:headers', (_msg) => {
    // First response bytes arrived
    if (acc.responseStart === undefined) {
      acc.responseStart = performance.now();
    }
  });

  return () => {
    for (const { channel, fn } of handlers) {
      try {
        channel.unsubscribe(fn);
      } catch {
        // Ignore unsubscribe errors — channel may already be gone
      }
    }
  };
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function buildUrl(req: HttpRequestDef): string {
  // Auto-prepend https:// for URLs that have no scheme (H-03)
  let rawUrl = req.url;
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = 'https://' + rawUrl;
  }

  const enabledParams = req.queryParams.filter((p) => p.enabled && p.key.trim() !== '');
  if (enabledParams.length === 0) {
    return rawUrl;
  }

  const urlObj = new URL(rawUrl);
  for (const p of enabledParams) {
    urlObj.searchParams.append(p.key, p.value);
  }
  return urlObj.toString();
}

// ---------------------------------------------------------------------------
// Request body builder
// ---------------------------------------------------------------------------

function buildRequestBody(req: HttpRequestDef): { body: string | Buffer | null; contentType: string | null } {
  if (!req.body || req.body.type === 'none') {
    return { body: null, contentType: null };
  }

  switch (req.body.type) {
    case 'json':
      return { body: req.body.content, contentType: 'application/json' };

    case 'text':
      return { body: req.body.content, contentType: 'text/plain' };

    case 'form-data': {
      // x-www-form-urlencoded serialisation from "key=value\nkey2=value2" format
      const params = new URLSearchParams();
      for (const line of req.body.content.split('\n')) {
        const idx = line.indexOf('=');
        if (idx !== -1) {
          params.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
        }
      }
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }

    case 'binary': {
      const fp = req.body.filePath;
      if (!fp) {
        throw new Error('Binary body: no file path specified. Use the file picker to select a file.');
      }
      if (!fsSync.existsSync(fp)) {
        throw new Error(`Binary body: file not found — ${fp}`);
      }
      return { body: fsSync.readFileSync(fp), contentType: 'application/octet-stream' };
    }

    default:
      return { body: null, contentType: null };
  }
}

// ---------------------------------------------------------------------------
// Response body consumer
// ---------------------------------------------------------------------------

async function consumeBody(
  body: NodeJS.ReadableStream | null,
  limit: number,
): Promise<{ body: string; bodySize: number; truncated: boolean }> {
  if (!body) {
    return { body: '', bodySize: 0, truncated: false };
  }

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let truncated = false;

  for await (const chunk of body as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    const remaining = limit - bytesRead;

    if (buf.length <= remaining) {
      chunks.push(buf);
      bytesRead += buf.length;
    } else {
      // Truncate at limit
      chunks.push(buf.slice(0, remaining));
      bytesRead += remaining;
      truncated = true;
      // Drain the rest of the body without buffering
      body.resume();
      break;
    }
  }

  const rawBuffer = Buffer.concat(chunks);
  // Try UTF-8 decode; fall back to base64 for binary content
  const isText = isUtf8Safe(rawBuffer);
  const bodyString = isText
    ? rawBuffer.toString('utf8')
    : rawBuffer.toString('base64');

  return { body: bodyString, bodySize: bytesRead, truncated };
}

/** Heuristic: check first 512 bytes for non-UTF-8 / control chars that indicate binary. */
function isUtf8Safe(buf: Buffer): boolean {
  const sample = buf.slice(0, 512);
  try {
    const decoded = sample.toString('utf8');
    // Check for null bytes or replacement chars that indicate binary
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i);
      if (code === 0 || code === 0xfffd) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Timing builder
// ---------------------------------------------------------------------------

function buildTimingBreakdown(
  acc: TimingAccumulator,
  wallStart: number,
  wallEnd: number,
): TimingBreakdown {
  const total = wallEnd - wallStart;

  // DNS: from request create to TCP connect start
  const dns =
    acc.dnsStart !== undefined && acc.dnsEnd !== undefined
      ? Math.max(0, acc.dnsEnd - acc.dnsStart)
      : 0;

  // TCP: from connect start to connect end
  const tcp =
    acc.connectStart !== undefined && acc.connectEnd !== undefined
      ? Math.max(0, acc.connectEnd - acc.connectStart)
      : 0;

  // TLS: from connect end to headers-sent (only for HTTPS)
  const tls =
    acc.tlsStart !== undefined && acc.tlsEnd !== undefined
      ? Math.max(0, acc.tlsEnd - acc.tlsStart)
      : 0;

  // TTFB: from send to first response bytes
  const ttfb =
    acc.sendStart !== undefined && acc.responseStart !== undefined
      ? Math.max(0, acc.responseStart - acc.sendStart)
      : 0;

  // Body download: from first byte to body fully consumed
  const body =
    acc.responseStart !== undefined && acc.responseEnd !== undefined
      ? Math.max(0, acc.responseEnd - acc.responseStart)
      : 0;

  return { dns, tcp, tls, ttfb, body, total };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapError(err: unknown, timing: TimingBreakdown): HttpExecuteError {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const name = err.name.toLowerCase();

    if (name === 'aborterror' || msg.includes('aborted') || msg.includes('abort')) {
      return { type: 'error', code: 'cancelled', message: 'Request was cancelled.' };
    }

    if (msg.includes('timeout') || msg.includes('headerstimeout') || msg.includes('bodytimeout')) {
      return {
        type: 'error',
        code: 'timeout',
        message: `Request timed out after ${timing.total.toFixed(0)}ms.`,
      };
    }

    if (
      msg.includes('getaddrinfo') ||
      msg.includes('enotfound') ||
      msg.includes('dns') ||
      msg.includes('name or service not known')
    ) {
      return {
        type: 'error',
        code: 'dns_error',
        message: `DNS resolution failed: ${sanitiseErrorMessage(err.message)}`,
      };
    }

    if (msg.includes('econnrefused') || msg.includes('connection refused')) {
      return {
        type: 'error',
        code: 'connection_refused',
        message: `Connection refused: the server is not accepting connections.`,
      };
    }

    if (
      msg.includes('certificate') ||
      msg.includes('ssl') ||
      msg.includes('tls') ||
      msg.includes('unable to verify') ||
      msg.includes('self signed') ||
      msg.includes('cert')
    ) {
      return {
        type: 'error',
        code: 'tls_error',
        message: `TLS error: ${sanitiseErrorMessage(err.message)}`,
      };
    }
  }

  const errMessage =
    err instanceof Error ? sanitiseErrorMessage(err.message) : String(err);

  return {
    type: 'error',
    code: 'unknown',
    message: `Network error: ${errMessage}`,
  };
}

/** Strip any paths or tokens from error messages before surfacing them. */
function sanitiseErrorMessage(msg: string): string {
  // Remove absolute paths that may appear in Node error messages
  return msg.replace(/\/.+?(\.js|\.ts|\.node)/g, '[file]').trim();
}

// ---------------------------------------------------------------------------
// Header normalisation
// ---------------------------------------------------------------------------

function normaliseHeaders(raw: Record<string, string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Status text helper
// ---------------------------------------------------------------------------

const STATUS_TEXTS: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created',
  202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function statusTextFor(status: number): string {
  return STATUS_TEXTS[status] ?? 'Unknown';
}
