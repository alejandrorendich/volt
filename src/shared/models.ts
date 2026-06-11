/**
 * @fileoverview Volt domain models — shared between extension host and webview.
 *
 * These types describe the core data structures that flow through the message
 * protocol. They MUST remain environment-agnostic (no `vscode`, no DOM APIs).
 *
 * @see design.md — Interfaces / Contracts
 * @see src/shared/protocol.ts — Message wrappers that carry these models
 */

// ---------------------------------------------------------------------------
// Auth configuration
// ---------------------------------------------------------------------------

/** No authentication. */
export interface AuthNone {
  readonly type: 'none';
}

/** Bearer token authentication — injects `Authorization: Bearer <token>`. */
export interface AuthBearer {
  readonly type: 'bearer';
  readonly token: string;
}

/** HTTP Basic authentication — injects `Authorization: Basic <base64(user:pass)>`. */
export interface AuthBasic {
  readonly type: 'basic';
  readonly username: string;
  readonly password: string;
}

/**
 * API key authentication — injects the key as a header or query parameter.
 */
export interface AuthApiKey {
  readonly type: 'apikey';
  readonly key: string;
  readonly value: string;
  /** Whether to inject the key as a header or append it as a query param. */
  readonly addTo: 'header' | 'query';
}

/**
 * OAuth2 authentication.
 *
 * `client_credentials` is the machine-to-machine flow. The `accessToken` field
 * holds the last fetched token; it is used as `Authorization: Bearer <token>`.
 *
 * `authorization_code` is included for UI display purposes. Token exchange
 * requires a callback server and is not automatically handled — users may
 * manually paste their access token into the `accessToken` field.
 */
export interface AuthOAuth2 {
  readonly type: 'oauth2';
  readonly grantType: 'client_credentials' | 'authorization_code';
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string;
  /** The last successfully fetched access token. Used as Bearer in requests. */
  readonly accessToken: string;
}

/**
 * AWS Signature Version 4 authentication.
 * Signs the request with HMAC-SHA256 and injects Authorization + X-Amz-Date headers.
 * `sessionToken` is optional — used for temporary STS credentials.
 */
export interface AuthAws {
  readonly type: 'aws';
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
  readonly sessionToken?: string;
}

/** Discriminated union of all supported auth configuration shapes. */
export type AuthConfig = AuthNone | AuthBearer | AuthBasic | AuthApiKey | AuthOAuth2 | AuthAws;

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

/** Supported HTTP methods. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * A single key-value query parameter with an enabled toggle so users can
 * disable individual params without deleting them.
 */
export interface QueryParam {
  readonly key: string;
  readonly value: string;
  /** When false the param is excluded from the final URL. Default: true */
  readonly enabled: boolean;
}

/**
 * Request body — discriminated by `type` so the UI renders the correct editor
 * and the host knows how to serialize it.
 *
 * The `binary` variant (REQ-RB-004) stores the absolute local file path.
 * The host reads the file and sends it as the raw request body.
 */
export type RequestBody =
  | { readonly type: 'json'; readonly content: string }
  | { readonly type: 'text'; readonly content: string }
  | { readonly type: 'form-data'; readonly content: string }
  | { readonly type: 'binary'; readonly filePath: string }
  | { readonly type: 'graphql'; readonly query: string; readonly variables: string; readonly operationName: string }
  | { readonly type: 'none' };

// ---------------------------------------------------------------------------
// Core request / response types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assertion types (Feature 5 — GUI-based testing)
// ---------------------------------------------------------------------------

/**
 * Subject of an assertion rule.
 * - `status`  — HTTP status code
 * - `time`    — total response time in milliseconds
 * - `jsonpath` — a value extracted from the JSON body via dot-notation path
 * - `header`  — a response header value by name
 */
export type AssertionSubject = 'status' | 'time' | 'jsonpath' | 'header';

/**
 * Comparison operator for an assertion rule.
 */
export type AssertionOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'exists';

/**
 * A single assertion rule attached to a request.
 * Evaluated after execution; results are pushed back as `event:assertion-results`.
 */
export interface AssertionRule {
  /** Stable identifier for this rule. */
  readonly id: string;
  /** What to inspect in the response. */
  readonly subject: AssertionSubject;
  /**
   * Context-sensitive path/name:
   * - `jsonpath` → dot-notation path like `"user.id"` or `"data[0].name"`
   * - `header`   → header name like `"Content-Type"`
   * - `status` / `time` → ignored (leave empty)
   */
  readonly property: string;
  /** How to compare the actual value to the expected value. */
  readonly operator: AssertionOperator;
  /**
   * Expected value as a string.
   * Supports `{{variable}}` interpolation (resolved before comparison).
   */
  readonly expected: string;
}

/**
 * The outcome of evaluating a single assertion rule after a request completes.
 */
export interface AssertionResult {
  readonly id: string;
  readonly pass: boolean;
  /** Stringified actual value (for display in the UI). */
  readonly actual: string;
}

/**
 * A fully-specified HTTP request definition.
 * Stored as YAML inside `.volt/requests/`.
 */
export interface HttpRequestDef {
  /**
   * Stable identifier — used as correlationId anchor and for tab management.
   * UUIDs are recommended; generated by the webview on creation.
   */
  readonly id: string;
  /** Human-readable display name shown in the collection tree. */
  readonly name?: string;
  readonly method: HttpMethod;
  /**
   * URL template — may contain `{{variable}}` placeholders resolved by
   * EnvironmentService before execution.
   */
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: RequestBody;
  readonly queryParams: readonly QueryParam[];
  /** JavaScript code executed BEFORE the request is sent. */
  readonly preScript?: string;
  /** JavaScript code executed AFTER the response is received. */
  readonly postScript?: string;
  /**
   * Authentication configuration for this request.
   * Injected into headers or query params AFTER environment variable interpolation.
   */
  readonly auth?: AuthConfig;
  /**
   * Request timeout in milliseconds.
   * When set, overrides the default 30 s timeout.
   * When null or undefined, the default timeout is used.
   */
  readonly timeout?: number;
  /** Per-request settings that override global defaults. */
  readonly settings?: {
    /** When false, TLS certificate verification is disabled for this request. Default: true */
    readonly sslVerify?: boolean;
    /** When false, 3xx redirects are NOT followed. Default: true */
    readonly followRedirects?: boolean;
  };
  /** GUI-based assertion rules evaluated after every execution. */
  readonly assertions?: readonly AssertionRule[];
}

// ---------------------------------------------------------------------------
// WebSocket / SSE types
// ---------------------------------------------------------------------------

/**
 * A single message in a WebSocket session — either sent by the user or
 * received from the server.
 */
export interface WsMessage {
  /** Stable UUID for this message. */
  readonly id: string;
  /** Direction from the client's perspective. */
  readonly direction: 'sent' | 'received';
  /** Text payload (binary frames are not supported in V1). */
  readonly data: string;
  /** ISO-8601 timestamp captured when the message was sent/received. */
  readonly timestamp: string;
}

/**
 * A single Server-Sent Events frame pushed from the server.
 */
export interface SseEvent {
  /** Optional `id:` field from the SSE stream. */
  readonly id?: string;
  /** Optional `event:` field (defaults to `"message"` when absent). */
  readonly event?: string;
  /** `data:` field content (may be multi-line, joined with `\n`). */
  readonly data: string;
  /** ISO-8601 timestamp of when this event was received. */
  readonly timestamp: string;
}

/**
 * Per-phase timing breakdown captured via `diagnostics_channel` hooks.
 * All values are in milliseconds.
 *
 * @see src/extension/services/http-service.ts
 */
export interface TimingBreakdown {
  /** DNS resolution time */
  readonly dns: number;
  /** TCP handshake time */
  readonly tcp: number;
  /** TLS negotiation time (0 for plain HTTP) */
  readonly tls: number;
  /** Time to first byte (from connection established to first response byte) */
  readonly ttfb: number;
  /** Body download time */
  readonly body: number;
  /** Total elapsed wall-clock time */
  readonly total: number;
}

/**
 * The timing phases emitted as progress events during a live request.
 */
export type TimingPhase = 'dns' | 'tcp' | 'tls' | 'ttfb' | 'body';

/**
 * An HTTP response as received by the extension host and forwarded to the
 * webview. The body is always a UTF-8 string (binary responses are base64).
 *
 * REQ-MSG-005: For bodies > 5 MB the body is written to a temp file and
 * `bodyRef` contains the `file:///` URI. The webview renders a "too large"
 * placeholder and offers a download link instead.
 */
export interface HttpResponseDef {
  /** Echoes the `id` of the originating `HttpRequestDef` */
  readonly requestId: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  /** Response body as a string (UTF-8 or base64 for binary). Empty when bodyRef is set. */
  readonly body: string;
  /** Byte count of the original body before any truncation */
  readonly bodySize: number;
  /**
   * Whether the body was truncated to the 50 MB safety limit.
   * @see REQ-HTTP-006
   */
  readonly truncated?: boolean;
  /**
   * For bodies > 5 MB: `file:///` URI to the temp file holding the full body.
   * When present, the `body` field is empty and the webview should show a
   * "Response too large to display (X MB). Click to save." placeholder.
   * @see REQ-MSG-005
   */
  readonly bodyRef?: string;
  readonly timing: TimingBreakdown;
}

// ---------------------------------------------------------------------------
// Collection types
// ---------------------------------------------------------------------------

/**
 * A single entry in the collection order array — either a named folder or a
 * direct request file reference.
 */
export type CollectionOrderEntry =
  | { readonly folder: string }
  | { readonly request: string };

/**
 * Represents an individual request item in the collection tree.
 */
export interface CollectionRequestItem {
  readonly kind: 'request';
  /** Relative path inside `.volt/requests/`, without extension */
  readonly path: string;
  readonly name: string;
  readonly method: HttpMethod;
}

/**
 * Represents a folder grouping requests in the collection tree.
 */
export interface CollectionFolderItem {
  readonly kind: 'folder';
  readonly name: string;
  readonly children: readonly CollectionTreeNode[];
}

/** A node in the collection tree — either a folder or a request. */
export type CollectionTreeNode = CollectionFolderItem | CollectionRequestItem;

/**
 * The root collection tree pushed to the webview after loading.
 * Mirrors `.volt/collection.yaml` with enriched metadata from request files.
 */
export interface CollectionTree {
  readonly name: string;
  readonly version: number;
  readonly nodes: readonly CollectionTreeNode[];
}

// ---------------------------------------------------------------------------
// Environment types
// ---------------------------------------------------------------------------

/**
 * A raw environment definition as stored in `.volt/envs/<name>.yaml`.
 */
export interface EnvironmentDef {
  readonly name: string;
  readonly variables: Record<string, string>;
}

/**
 * The fully resolved environment sent to the webview after scope-chain
 * resolution. Variables from higher-priority scopes have already overridden
 * lower-priority ones.
 *
 * Scope priority (high → low): request → collection → project → global
 */
export interface ResolvedEnv {
  /** Active environment name */
  readonly active: string;
  /** All available environment names for the switcher dropdown */
  readonly available: readonly string[];
  /** Merged variable map after scope-chain resolution */
  readonly variables: Record<string, string>;
}
