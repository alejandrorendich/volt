/**
 * @fileoverview Volt Message Router.
 *
 * Receives raw postMessage payloads from the webview (`HostMessage` union),
 * dispatches them to the appropriate service handler, and sends typed
 * `WebviewMessage` responses back.
 *
 * Responsibilities:
 * - Parse and type-narrow incoming messages (discriminated union switch)
 * - Maintain a "handshake queue" — buffer outbound messages until the webview
 *   signals it is ready via `webview-ready`
 * - Track request/response correlation IDs
 * - Wrap all handler errors into typed `execute-error` responses (INTERNAL_ERROR)
 * - Log unknown message types as warnings (never crash)
 *
 * @see REQ-MSG-001 — Message Protocol Structure
 * @see REQ-MSG-002 — Error Propagation
 * @see REQ-MSG-006 — Webview Ready Handshake
 */

import * as vscode from 'vscode';
import type {
  HostMessage,
  WebviewMessage,
  CorrelationId,
} from '../shared/protocol';

// ---------------------------------------------------------------------------
// Service interface stubs (filled by later phases)
// ---------------------------------------------------------------------------

/**
 * Minimal service interface the router expects for HTTP execution.
 * Phase 3 provides the concrete implementation.
 */
export interface IHttpService {
  execute(request: import('../shared/models').HttpRequestDef, correlationId: CorrelationId): Promise<import('../shared/models').HttpResponseDef>;
  cancel(requestId: string): void;
}

/**
 * Minimal service interface for collection I/O.
 * Phase 4 provides the concrete implementation.
 */
export interface ICollectionService {
  loadTree(): Promise<import('../shared/models').CollectionTree>;
  saveRequest(filePath: string, request: import('../shared/models').HttpRequestDef): Promise<void>;
}

/**
 * Minimal service interface for environment variable resolution.
 * Phase 3 provides the concrete implementation.
 */
export interface IEnvironmentService {
  setActive(name: string): Promise<void>;
  getResolved(): Promise<import('../shared/models').ResolvedEnv>;
  /** Apply {{var}} interpolation to all fields of a request. */
  resolveRequest?(
    request: import('../shared/models').HttpRequestDef,
    requestVars?: Record<string, string>,
    collectionVars?: Record<string, string>,
  ): import('../shared/models').HttpRequestDef;
}

// ---------------------------------------------------------------------------
// MessageRouter
// ---------------------------------------------------------------------------

/**
 * Dependency container passed to the router at construction time.
 * Services are optional so the router can be instantiated in Phase 2 before
 * the services are implemented.
 */
export interface RouterServices {
  readonly http?: IHttpService;
  readonly collection?: ICollectionService;
  readonly environment?: IEnvironmentService;
}

export class MessageRouter implements vscode.Disposable {
  private webview: vscode.Webview | undefined;
  private readonly output: vscode.OutputChannel;
  private readonly services: RouterServices;

  /** Messages queued before the webview-ready handshake fires. */
  private readonly pendingQueue: WebviewMessage[] = [];
  private isWebviewReady = false;

  constructor(output: vscode.OutputChannel, services: RouterServices = {}) {
    this.output = output;
    this.services = services;
  }

  // ---------------------------------------------------------------------------
  // Webview binding
  // ---------------------------------------------------------------------------

  /**
   * Called by the WebviewProvider when a panel opens (or is restored).
   * Setting `undefined` signals the panel was closed; the queue is reset.
   */
  setWebview(webview: vscode.Webview | undefined): void {
    this.webview = webview;
    if (!webview) {
      // Panel closed — reset handshake state for the next open
      this.isWebviewReady = false;
      this.pendingQueue.length = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound — webview → host
  // ---------------------------------------------------------------------------

  /**
   * Entry point for all raw postMessage payloads arriving from the webview.
   * Called by `WebviewProvider` inside `onDidReceiveMessage`.
   */
  receive(raw: unknown, _webview: vscode.Webview): void {
    if (!isHostMessage(raw)) {
      this.output.appendLine(`[MessageRouter] WARNING: unrecognised message — ${JSON.stringify(raw)}`);
      return;
    }

    const msg = raw as HostMessage;
    this.dispatch(msg).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR dispatching ${msg.type}: ${message}`);
      this.sendToWebview({
        type: 'execute-error',
        correlationId: msg.correlationId,
        payload: {
          message: `Internal error: ${message}`,
          code: 'unknown',
        },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Outbound — host → webview
  // ---------------------------------------------------------------------------

  /**
   * Send a typed message to the webview.
   * If the webview is not yet ready, the message is queued and flushed later.
   */
  send(message: WebviewMessage): void {
    if (!this.isWebviewReady) {
      this.pendingQueue.push(message);
      this.output.appendLine(`[MessageRouter] Queued message (webview not ready): ${message.type}`);
      return;
    }

    this.sendToWebview(message);
  }

  // ---------------------------------------------------------------------------
  // Dispatch — switch on message type
  // ---------------------------------------------------------------------------

  private async dispatch(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case 'webview-ready':
        await this.handleWebviewReady(msg.correlationId);
        break;

      case 'execute-request':
        await this.handleExecuteRequest(msg.correlationId, msg.payload);
        break;

      case 'cancel-request':
        this.handleCancelRequest(msg.payload.id);
        break;

      case 'save-request':
        await this.handleSaveRequest(msg.correlationId, msg.payload);
        break;

      case 'load-collection':
        await this.handleLoadCollection(msg.correlationId);
        break;

      case 'set-environment':
        await this.handleSetEnvironment(msg.correlationId, msg.payload.name);
        break;

      default: {
        // Exhaustiveness guard — TypeScript will error if a new variant is
        // added to HostMessage without being handled here.
        const _exhaustive: never = msg;
        this.output.appendLine(`[MessageRouter] WARNING: unhandled message type — ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /**
   * Webview signals it is mounted and ready.
   * Flush all queued messages in arrival order (REQ-MSG-006).
   */
  private async handleWebviewReady(correlationId: CorrelationId): Promise<void> {
    this.output.appendLine('[MessageRouter] webview-ready received — flushing queue');
    this.isWebviewReady = true;

    for (const queued of this.pendingQueue) {
      this.sendToWebview(queued);
    }
    this.pendingQueue.length = 0;

    // Acknowledge the handshake (optional but useful for diagnostics)
    this.output.appendLine(`[MessageRouter] Handshake complete (correlationId: ${correlationId})`);
  }

  /** Execute an HTTP request via HttpService (Phase 3 wires the real service). */
  private async handleExecuteRequest(
    correlationId: CorrelationId,
    request: import('../shared/models').HttpRequestDef,
  ): Promise<void> {
    if (!this.services.http) {
      this.sendToWebview({
        type: 'execute-error',
        correlationId,
        payload: { message: 'HTTP service not yet available', code: 'unknown' },
      });
      return;
    }

    try {
      // Apply environment variable interpolation before executing (REQ-ENV-003)
      const resolvedRequest =
        this.services.environment?.resolveRequest?.(request) ?? request;

      const response = await this.services.http.execute(resolvedRequest, correlationId);
      this.sendToWebview({ type: 'execute-response', correlationId, payload: response });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Map structured error codes from HttpService (attached as err.code)
      const code = (err instanceof Error && (err as NodeJS.ErrnoException).code)
        ? (err as NodeJS.ErrnoException).code
        : 'unknown';
      this.sendToWebview({
        type: 'execute-error',
        correlationId,
        payload: { message, code: code as import('../shared/protocol').ExecuteErrorCode },
      });
    }
  }

  /** Cancel an in-flight HTTP request. */
  private handleCancelRequest(requestId: string): void {
    if (this.services.http) {
      this.services.http.cancel(requestId);
    }
  }

  /** Persist a request definition via CollectionService (Phase 4). */
  private async handleSaveRequest(
    correlationId: CorrelationId,
    payload: { path: string; request: import('../shared/models').HttpRequestDef },
  ): Promise<void> {
    if (!this.services.collection) {
      this.output.appendLine('[MessageRouter] CollectionService not yet available — save-request ignored');
      return;
    }

    try {
      await this.services.collection.saveRequest(payload.path, payload.request);
      // Reload the tree so the webview reflects the new request
      await this.handleLoadCollection(correlationId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in save-request: ${message}`);
    }
  }

  /** Load the collection tree (Phase 4 wires the real service). */
  private async handleLoadCollection(correlationId: CorrelationId): Promise<void> {
    if (!this.services.collection) {
      // Return an empty tree so the webview can render a useful empty state
      this.sendToWebview({
        type: 'collection-loaded',
        correlationId,
        payload: { name: '', version: 1, nodes: [] },
      });
      return;
    }

    try {
      const tree = await this.services.collection.loadTree();
      this.sendToWebview({ type: 'collection-loaded', correlationId, payload: tree });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in load-collection: ${message}`);
    }
  }

  /** Activate an environment (Phase 3 wires the real service). */
  private async handleSetEnvironment(
    correlationId: CorrelationId,
    name: string,
  ): Promise<void> {
    if (!this.services.environment) {
      this.output.appendLine('[MessageRouter] EnvironmentService not yet available — set-environment ignored');
      return;
    }

    try {
      await this.services.environment.setActive(name);
      const resolved = await this.services.environment.getResolved();
      this.sendToWebview({ type: 'environment-changed', correlationId, payload: resolved });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in set-environment: ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal send — bypasses queue (used for flushing and error responses)
  // ---------------------------------------------------------------------------

  private sendToWebview(message: WebviewMessage): void {
    if (!this.webview) {
      this.output.appendLine(`[MessageRouter] WARNING: no webview to send to (type: ${message.type})`);
      return;
    }

    try {
      void this.webview.postMessage(message);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR sending message: ${errMsg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Disposable
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.pendingQueue.length = 0;
    this.webview = undefined;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Narrow an unknown postMessage payload to `HostMessage`.
 * Validates only the structural minimum (`type` string field); full schema
 * validation is done per-handler.
 */
function isHostMessage(value: unknown): value is HostMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as Record<string, unknown>)['type'] === 'string'
  );
}
