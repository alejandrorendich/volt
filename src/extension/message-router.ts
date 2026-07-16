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
import * as fs from 'fs';
import * as path from 'path';
import type {
  HostMessage,
  WebviewMessage,
  CorrelationId,
  HistoryEntry,
  ExecuteErrorCode,
} from '../shared/protocol';
import type { CookieService } from './services/cookie-service';
import { WebSocketService } from './services/websocket-service';
import { SseService } from './services/sse-service';
import type {
  CollectionTree,
  CollectionTreeNode,
  HttpMethod,
  HttpRequestDef,
  HttpResponseDef,
  QueryParam,
  RequestBody,
  ResolvedEnv,
  TimingPhase,
} from '../shared/models';
import type * as AwsSigV4Module from './utils/aws-sigv4';

// ---------------------------------------------------------------------------
// Service interface stubs (filled by later phases)
// ---------------------------------------------------------------------------

/**
 * Minimal service interface the router expects for HTTP execution.
 * Phase 3 provides the concrete implementation.
 */
export interface IHttpService {
  execute(
    request: HttpRequestDef,
    correlationId: CorrelationId,
    onProgress?: (phase: TimingPhase, elapsed: number) => void,
  ): Promise<HttpResponseDef>;
  cancel(requestId: string): void;
}

/**
 * Minimal service interface for collection I/O.
 * Phase 4 provides the concrete implementation.
 */
export interface ICollectionService {
  loadTree(): Promise<CollectionTree>;
  saveRequest(filePath: string, request: HttpRequestDef): Promise<string>;
  getRequest(filePath: string): Promise<HttpRequestDef | null>;
  createFolder(relativeFolderPath: string): Promise<void>;
}

/**
 * Minimal service interface for environment variable resolution.
 * Phase 3 provides the concrete implementation.
 */
export interface IEnvironmentService {
  setActive(name: string): Promise<void>;
  getResolved(): Promise<ResolvedEnv>;
  /** Create a new environment file. */
  createEnvironment(name: string): Promise<void>;
  /** Update variables in the active environment file (merge). */
  updateVariables(updates: Record<string, string>): Promise<void>;
  /** Delete a single variable from the active environment file. */
  deleteVariable(key: string): Promise<void>;
  /** Delete an entire environment file and auto-switch. */
  deleteEnvironment(name: string): Promise<void>;
  /** Rename an environment (renames the YAML file). */
  renameEnvironment(oldName: string, newName: string): Promise<void>;
  /** Apply {{var}} interpolation to all fields of a request. */
  resolveRequest?(
    request: HttpRequestDef,
    requestVars?: Record<string, string>,
    collectionVars?: Record<string, string>,
  ): HttpRequestDef;
}

/**
 * Minimal service interface for per-request execution history.
 */
export interface IHistoryService {
  addEntry(requestPath: string, entry: HistoryEntry): void;
  getHistory(requestPath: string): HistoryEntry[];
  clearHistory(requestPath: string): void;
  deleteEntry(requestPath: string, timestamp: string): void;
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
  readonly history?: IHistoryService;
  readonly cookies?: CookieService;
}

export class MessageRouter implements vscode.Disposable {
  private webview: vscode.Webview | undefined;
  private readonly output: vscode.OutputChannel;
  private readonly services: RouterServices;

  /** Messages queued before the webview-ready handshake fires. */
  private readonly pendingQueue: WebviewMessage[] = [];
  private isWebviewReady = false;

  /**
   * Callback fired whenever the webview reports its dirty state changed.
   * The WebviewProvider uses this to update the panel title and to
   * decide whether to show a warning on panel close.
   */
  onDirtyStateChanged?: (dirty: boolean) => void;

  /** Optional callback fired after a successful environment switch. */
  onEnvironmentChanged?: (envName: string) => void;

  /** Optional callback fired after an import to refresh the tree. */
  treeRefresh?: () => void;

  /** WebSocket service — one connection per panel session. */
  private wsService: WebSocketService | null = null;
  /** correlationId of the current WebSocket connect request. */
  private wsCorrelationId: CorrelationId = '';

  /** SSE service — manages in-flight SSE streams. */
  private readonly sseService: SseService;

  constructor(output: vscode.OutputChannel, services: RouterServices = {}) {
    this.output = output;
    this.services = services;
    this.sseService = new SseService(output);
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

    const msg = raw;
    this.dispatch(msg).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR dispatching ${msg.type}: ${message}`);
      this.sendToWebview({
        type: 'response:execute-error',
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

  /**
   * Push a saved request from the collection into the webview builder.
   * Called by `volt.openRequest` command when the user clicks a tree item
   * (REQ-COL-001 — tree click loads request into builder).
   */
  pushRequest(requestPath: string): void {
    if (!this.services.collection) return;

    this.services.collection.getRequest(requestPath).then((request) => {
      if (!request) {
        this.output.appendLine(`[MessageRouter] WARN: request not found — ${requestPath}`);
        return;
      }
      // Ensure id matches the relative path (used as savePath in webview)
      const requestWithPath = { ...request, id: requestPath };
      this.send({
        type: 'event:load-request',
        correlationId: `load-${Date.now()}`,
        payload: requestWithPath,
      });
    }).catch((err: unknown) => {
      this.output.appendLine(`[MessageRouter] ERROR pushing request: ${String(err)}`);
    });
  }

  /**
   * Ask the webview to open an empty new-request tab. No file is created
   * until the user fills the form and saves — at that point the host's
   * `handleSaveRequest` either uses an existing `savePath` or prompts for one.
   *
   * Used by `volt.newRequest` after my custom Change to decouple file
   * creation from click — gives a natural Save-As UX.
   */
  openEmptyNewRequest(): void {
    this.send({
      type: 'event:new-request',
      correlationId: `newreq-${Date.now()}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatch — switch on message type
  // ---------------------------------------------------------------------------

  private async dispatch(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case 'request:ready':
        await this.handleWebviewReady(msg.correlationId);
        break;

      case 'request:execute-http':
        await this.handleExecuteRequest(msg.correlationId, msg.payload);
        break;

      case 'request:cancel-http':
        this.handleCancelRequest(msg.payload.id);
        break;

      case 'request:save-request':
        await this.handleSaveRequest(msg.correlationId, msg.payload);
        break;

      case 'request:get-collection':
        await this.handleLoadCollection(msg.correlationId);
        break;

      case 'request:set-environment':
        await this.handleSetEnvironment(msg.correlationId, msg.payload.name);
        break;

      case 'request:get-request':
        await this.handleGetRequest(msg.correlationId, msg.payload.path);
        break;

      case 'request:save-to-file':
        await this.handleSaveToFile(msg.payload.suggestedName, msg.payload.content);
        break;

      case 'request:create-environment':
        await this.handleCreateEnvironment(msg.correlationId, msg.payload.name);
        break;

      case 'request:update-env-var':
        await this.handleUpdateEnvVar(msg.correlationId, msg.payload.key, msg.payload.value);
        break;

      case 'request:delete-env-var':
        await this.handleDeleteEnvVar(msg.correlationId, msg.payload.key);
        break;

      case 'request:delete-environment':
        await this.handleDeleteEnvironment(msg.correlationId, msg.payload.name);
        break;

      case 'request:rename-environment':
        await this.handleRenameEnvironment(msg.correlationId, msg.payload.oldName, msg.payload.newName);
        break;

      case 'request:pick-binary-file':
        await this.handlePickBinaryFile(msg.correlationId);
        break;

      case 'request:export-request':
        await this.handleExportRequest(msg.correlationId, msg.payload.path);
        break;

      case 'request:export-folder':
        await this.handleExportFolder(msg.correlationId, msg.payload.folder);
        break;

      case 'request:import':
        await this.handleImport(msg.correlationId);
        break;

      case 'request:get-history':
        this.handleGetHistory(msg.correlationId, msg.payload.path);
        break;

      case 'request:clear-history':
        this.handleClearHistory(msg.payload.path);
        break;

      case 'request:delete-history-entry':
        this.handleDeleteHistoryEntry(msg.payload.path, msg.payload.timestamp);
        break;

      case 'request:run-collection':
        await this.handleRunCollection(msg.correlationId, msg.payload.folder, msg.payload.delay ?? 0);
        break;

      case 'request:clear-cookies':
        this.handleClearCookies();
        break;

      case 'request:oauth2-get-token':
        await this.handleOAuth2GetToken(msg.correlationId, msg.payload);
        break;

      case 'request:ws-connect':
        this.handleWsConnect(msg.correlationId, msg.payload.url, msg.payload.headers);
        break;

      case 'request:ws-send':
        this.handleWsSend(msg.payload.message);
        break;

      case 'request:ws-disconnect':
        this.handleWsDisconnect();
        break;

      case 'webview:set-dirty':
        this.handleSetDirty(msg.payload.dirty);
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
   * Flush all queued messages in arrival order, then push initial state
   * (collection + active environment) so the UI bootstraps without a round-trip
   * request from the webview (REQ-MSG-006, REQ-MSG-003).
   */
  private async handleWebviewReady(correlationId: CorrelationId): Promise<void> {
    this.output.appendLine('[MessageRouter] webview-ready received — flushing queue');
    this.isWebviewReady = true;

    for (const queued of this.pendingQueue) {
      this.sendToWebview(queued);
    }
    this.pendingQueue.length = 0;

    this.output.appendLine(`[MessageRouter] Handshake complete (correlationId: ${correlationId})`);

    // --- Push initial state to the newly-ready webview ---

    // 1. Push collection tree so the sidebar / collection panel renders immediately
    if (this.services.collection) {
      try {
        const tree = await this.services.collection.loadTree();
        this.sendToWebview({ type: 'response:collection', correlationId, payload: tree });
      } catch (err: unknown) {
        this.output.appendLine(`[MessageRouter] WARN: initial collection push failed — ${String(err)}`);
      }
    }

    // 2. Push active environment so variables resolve on first request
    if (this.services.environment) {
      try {
        const resolved = await this.services.environment.getResolved();
        this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
      } catch (err: unknown) {
        this.output.appendLine(`[MessageRouter] WARN: initial env push failed — ${String(err)}`);
      }
    }
  }

  /** Execute an HTTP request via HttpService (Phase 3 wires the real service). */
  private async handleExecuteRequest(
    correlationId: CorrelationId,
    request: HttpRequestDef,
  ): Promise<void> {
    if (!this.services.http) {
      this.sendToWebview({
        type: 'response:execute-error',
        correlationId,
        payload: { message: 'HTTP service not yet available', code: 'unknown' },
      });
      return;
    }

    try {
      // Apply environment variable interpolation before executing (REQ-ENV-003)
      const resolvedRequest =
        this.services.environment?.resolveRequest?.(request) ?? request;

      // Inject auth headers / query params AFTER interpolation so {{token}} is resolved
      const authedRequest = applyAuth(resolvedRequest);

      // SSE detection: if Accept header contains text/event-stream, stream events instead
      const acceptHeader =
        authedRequest.headers['Accept'] ??
        authedRequest.headers['accept'] ??
        '';
      if (acceptHeader.includes('text/event-stream')) {
        await this.handleSseRequest(correlationId, authedRequest);
        return;
      }

      // Inject cookies from the cookie jar if available (Feature 8)
      const cookieHeader = this.services.cookies?.getCookies(authedRequest.url) ?? '';
      const requestWithCookies = cookieHeader
        ? { ...authedRequest, headers: { ...authedRequest.headers, Cookie: cookieHeader } }
        : authedRequest;

      // Run pre-script if present
      if (request.preScript) {
        const { ScriptRunner } = await import('./services/script-runner');
        const envVars = (await this.services.environment?.getResolved())?.variables ?? {};
        const runner = new ScriptRunner(this.output, envVars);
        const preResult = await runner.runPreScript(request.preScript, requestWithCookies);
        if (!preResult.success) {
          this.sendToWebview({
            type: 'response:execute-error',
            correlationId,
            payload: { message: `Pre-script error: ${preResult.error}`, code: 'unknown' },
          });
          return;
        }
        // Apply any env.set() from pre-script
        if (Object.keys(preResult.envUpdates).length > 0) {
          await this.persistEnvUpdates(preResult.envUpdates);
        }
      }

      // Progress callback — pushes event:request-progress to webview (REQ-MSG-003)
      const onProgress = (phase: TimingPhase, elapsed: number): void => {
        this.sendToWebview({
          type: 'event:request-progress',
          correlationId,
          payload: { phase, elapsed },
        });
      };

      const response = await this.services.http.execute(requestWithCookies, correlationId, onProgress);

      // Capture Set-Cookie headers from response into the cookie jar (Feature 8)
      if (this.services.cookies) {
        this.services.cookies.captureCookies(requestWithCookies.url, response.headers);
      }

      // Run post-script if present
      if (request.postScript) {
        const { ScriptRunner } = await import('./services/script-runner');
        const envVars = (await this.services.environment?.getResolved())?.variables ?? {};
        const runner = new ScriptRunner(this.output, envVars);
        const postResult = await runner.runPostScript(request.postScript, response);
        if (!postResult.success) {
          this.output.appendLine(`[MessageRouter] Post-script error: ${postResult.error}`);
          // Surface the error in the webview Scripts tab — non-blocking
          this.sendToWebview({
            type: 'event:script-error',
            correlationId,
            payload: { phase: 'post', message: postResult.error ?? 'Unknown post-script error' },
          });
        }
        // Persist any env.set() from post-script to the active environment file
        if (Object.keys(postResult.envUpdates).length > 0) {
          await this.persistEnvUpdates(postResult.envUpdates);
          // Notify webview of env change
          const resolved = await this.services.environment?.getResolved();
          if (resolved) {
            this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
          }
        }
      }

      this.sendToWebview({ type: 'response:execute-http', correlationId, payload: response });

      // Evaluate assertions if the request has any (Feature 5)
      if (request.assertions && request.assertions.length > 0) {
        const { evaluateAssertions } = await import('./services/assertion-evaluator');
        const envVarsForAssertions = (await this.services.environment?.getResolved())?.variables ?? {};
        const assertionResults = evaluateAssertions(request.assertions, response, envVarsForAssertions);
        this.sendToWebview({
          type: 'event:assertion-results',
          correlationId,
          payload: { results: assertionResults },
        });
      }

      // Record execution in history (only for saved requests with a savePath — REQ-HIST-001)
      if (this.services.history && request.id) {
        const entry: HistoryEntry = {
          timestamp: new Date().toISOString(),
          method: resolvedRequest.method,
          url: resolvedRequest.url,
          status: response.status,
          statusText: response.statusText,
          time: response.timing.total,
          success: response.status >= 200 && response.status < 400,
          body: response.body,
          headers: response.headers,
        };
        this.services.history.addEntry(request.id, entry);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Map structured error codes from HttpService (attached as err.code)
      const code = (err instanceof Error && (err as NodeJS.ErrnoException).code)
        ? (err as NodeJS.ErrnoException).code
        : 'unknown';
        this.sendToWebview({
          type: 'response:execute-error',
          correlationId,
          payload: { message, code: code as ExecuteErrorCode },
        });
    }
  }

  /** Cancel an in-flight HTTP request or SSE stream. */
  private handleCancelRequest(requestId: string): void {
    if (this.services.http) {
      this.services.http.cancel(requestId);
    }
    // Also abort any in-flight SSE stream with the same correlationId
    this.sseService.abort(requestId);
  }

  /**
   * Persist env.set() updates from scripts to the active environment file.
   */
  private async persistEnvUpdates(updates: Record<string, string>): Promise<void> {
    if (!this.services.environment) return;
    try {
      await this.services.environment.updateVariables(updates);
    } catch (err: unknown) {
      this.output.appendLine(`[MessageRouter] Failed to persist env updates: ${String(err)}`);
    }
  }

  /** Persist a request definition via CollectionService (Phase 4). */
  private async handleSaveRequest(
    correlationId: CorrelationId,
    payload: { path: string; request: HttpRequestDef },
  ): Promise<void> {
    if (!this.services.collection) {
      this.output.appendLine('[MessageRouter] CollectionService not yet available — save-request ignored');
      return;
    }

    let savePath = payload.path;

    // If no path provided, ask user for a name via VS Code input box
    if (!savePath) {
      const name = await vscode.window.showInputBox({
        prompt: 'Request name',
        placeHolder: 'e.g. get-users',
        validateInput: (value) => {
          if (!value) return 'Name is required';
          if (!/^[a-zA-Z0-9_/-]+$/.test(value)) return 'Only letters, numbers, hyphens, underscores, and slashes';
          return undefined;
        },
      });
      if (!name) return; // User cancelled
      savePath = name;
    }

    try {
      const requestWithName = { ...payload.request, name: payload.request.name ?? (savePath.split('/').pop() ?? savePath) };
      const resolvedPath = await this.services.collection.saveRequest(savePath, requestWithName);
      // Confirm save to webview with the resolved path (may differ if method-disambiguated)
      this.sendToWebview({
        type: 'response:request-saved',
        correlationId,
        payload: { path: resolvedPath },
      });
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
        type: 'response:collection',
        correlationId,
        payload: { name: '', version: 1, nodes: [] },
      });
      return;
    }

    try {
      const tree = await this.services.collection.loadTree();
      this.sendToWebview({ type: 'response:collection', correlationId, payload: tree });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in load-collection: ${message}`);
      // Send empty tree so the webview shows an empty state rather than hanging (C-05)
      this.sendToWebview({
        type: 'response:collection',
        correlationId,
        payload: { name: '', version: 1, nodes: [] },
      });
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
      this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
      // Notify status bar (and any other listeners) of the change
      this.onEnvironmentChanged?.(resolved.active);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in set-environment: ${message}`);
      // Notify webview so it can surface a toast/error notification (C-05)
      this.sendToWebview({
        type: 'response:execute-error',
        correlationId,
        payload: { message: `Failed to switch environment: ${message}`, code: 'unknown' },
      });
    }
  }

  /** Create a new environment and activate it. */
  private async handleCreateEnvironment(
    correlationId: CorrelationId,
    name: string,
  ): Promise<void> {
    if (!this.services.environment) {
      this.output.appendLine('[MessageRouter] EnvironmentService not available — create-environment ignored');
      return;
    }

    try {
      await this.services.environment.createEnvironment(name);
      await this.services.environment.setActive(name);
      const resolved = await this.services.environment.getResolved();
      this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
      this.onEnvironmentChanged?.(resolved.active);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in create-environment: ${message}`);
    }
  }

  /** Set or update a single variable in the active environment. */
  private async handleUpdateEnvVar(
    correlationId: CorrelationId,
    key: string,
    value: string,
  ): Promise<void> {
    if (!this.services.environment) {
      this.output.appendLine('[MessageRouter] EnvironmentService not available — update-env-var ignored');
      return;
    }

    try {
      await this.services.environment.updateVariables({ [key]: value });
      const resolved = await this.services.environment.getResolved();
      this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in update-env-var: ${message}`);
    }
  }

  /** Delete a single variable from the active environment. */
  private async handleDeleteEnvVar(
    correlationId: CorrelationId,
    key: string,
  ): Promise<void> {
    if (!this.services.environment) {
      this.output.appendLine('[MessageRouter] EnvironmentService not available — delete-env-var ignored');
      return;
    }

    try {
      await this.services.environment.deleteVariable(key);
      const resolved = await this.services.environment.getResolved();
      this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in delete-env-var: ${message}`);
    }
  }

  /** Delete an entire environment file and auto-switch to the next one. */
  private async handleDeleteEnvironment(
    correlationId: CorrelationId,
    name: string,
  ): Promise<void> {
    if (!this.services.environment) {
      this.output.appendLine('[MessageRouter] EnvironmentService not available — delete-environment ignored');
      return;
    }

    try {
      await this.services.environment.deleteEnvironment(name);
      const resolved = await this.services.environment.getResolved();
      this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
      this.onEnvironmentChanged?.(resolved.active);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in delete-environment: ${message}`);
    }
  }

  private async handleRenameEnvironment(
    correlationId: CorrelationId,
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (!this.services.environment) {
      this.output.appendLine('[MessageRouter] EnvironmentService not available — rename-environment ignored');
      return;
    }

    try {
      await this.services.environment.renameEnvironment(oldName, newName);
      const resolved = await this.services.environment.getResolved();
      this.sendToWebview({ type: 'event:environment-changed', correlationId, payload: resolved });
      this.onEnvironmentChanged?.(resolved.active);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in rename-environment: ${message}`);
    }
  }

  /** Load a single request by path and push it to the webview builder. */
  private async handleGetRequest(
    correlationId: CorrelationId,
    requestPath: string,
  ): Promise<void> {
    if (!this.services.collection) {
      this.output.appendLine('[MessageRouter] CollectionService not available — get-request ignored');
      return;
    }

    try {
      const request = await this.services.collection.getRequest(requestPath);
      if (!request) {
        this.output.appendLine(`[MessageRouter] WARN: request not found — ${requestPath}`);
        return;
      }
      // Ensure id matches the relative path (used as savePath in webview)
      const requestWithPath = { ...request, id: requestPath };
      this.sendToWebview({ type: 'event:load-request', correlationId, payload: requestWithPath });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in get-request: ${message}`);
      // Notify webview so it can surface an error notification (C-05)
      this.sendToWebview({
        type: 'response:execute-error',
        correlationId,
        payload: { message: `Failed to load request: ${message}`, code: 'unknown' },
      });
    }
  }

  /**
   * Open a native file picker and return the selected file path to the webview
   * as `response:binary-file-picked`. Used by BinaryBodyPicker (C-01).
   */
  private async handlePickBinaryFile(correlationId: CorrelationId): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select File',
      title: 'Select Binary Body File',
    });

    if (!uris || uris.length === 0) {
      this.sendToWebview({ type: 'response:binary-file-picked', correlationId, payload: null });
      return;
    }

    const uri = uris[0];
    if (!uri) {
      this.sendToWebview({ type: 'response:binary-file-picked', correlationId, payload: null });
      return;
    }
    const fsPath = uri.fsPath;
    const name = fsPath.split(/[\\/]/).pop() ?? fsPath;
    this.sendToWebview({
      type: 'response:binary-file-picked',
      correlationId,
      payload: { path: fsPath, name },
    });
  }

  /**
   * Export a single request to a `.volt-request.json` file via native save dialog.
   */
  private async handleExportRequest(
    _correlationId: CorrelationId,
    requestPath: string,
  ): Promise<void> {
    if (!this.services.collection) {
      void vscode.window.showWarningMessage('Volt: Open a folder to export requests.');
      return;
    }

    try {
      const request = await this.services.collection.getRequest(requestPath);
      if (!request) {
        void vscode.window.showWarningMessage(`Volt: Request not found — ${requestPath}`);
        return;
      }

      const exportObj = {
        volt_version: '1.0',
        type: 'request',
        exported_at: new Date().toISOString(),
        request: {
          name: request.name ?? requestPath.split('/').pop() ?? requestPath,
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body,
          queryParams: request.queryParams,
          preScript: request.preScript,
          postScript: request.postScript,
        },
      };

      const suggestedName = `${request.name ?? requestPath.split('/').pop() ?? 'request'}.volt-request.json`;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(suggestedName),
        filters: { 'Volt Request': ['volt-request.json'] },
        saveLabel: 'Export',
        title: 'Export Request',
      });
      if (!uri) return;

      fs.writeFileSync(uri.fsPath, JSON.stringify(exportObj, null, 2), 'utf8');
      void vscode.window.showInformationMessage(`Volt: Request exported to ${path.basename(uri.fsPath)}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in export-request: ${message}`);
      void vscode.window.showErrorMessage(`Volt: Export failed — ${message}`);
    }
  }

  /**
   * Export all requests in a folder to a `.volt-collection.json` file.
   */
  private async handleExportFolder(
    _correlationId: CorrelationId,
    folder: string,
  ): Promise<void> {
    if (!this.services.collection) {
      void vscode.window.showWarningMessage('Volt: Open a folder to export collections.');
      return;
    }

    try {
      const tree = await this.services.collection.loadTree();
      const folderNode = tree.nodes.find(
        (n) => n.kind === 'folder' && n.name === folder,
      );
      if (!folderNode || folderNode.kind !== 'folder') {
        void vscode.window.showWarningMessage(`Volt: Folder not found — ${folder}`);
        return;
      }

      // Collect all request paths inside the folder (recursive)
      const requestPaths: string[] = [];
      const collectPaths = (
        nodes: readonly CollectionTreeNode[],
      ): void => {
        for (const node of nodes) {
          if (node.kind === 'request') {
            requestPaths.push(node.path);
          } else if (node.kind === 'folder') {
            collectPaths(node.children);
          }
        }
      };
      collectPaths(folderNode.children);

      const requests: unknown[] = [];
      for (const reqPath of requestPaths) {
        const request = await this.services.collection.getRequest(reqPath);
        if (request) {
          requests.push({
            name: request.name ?? reqPath.split('/').pop() ?? reqPath,
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
            queryParams: request.queryParams,
            preScript: request.preScript,
            postScript: request.postScript,
          });
        }
      }

      const exportObj = {
        volt_version: '1.0',
        type: 'collection',
        exported_at: new Date().toISOString(),
        folder,
        requests,
      };

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${folder}.volt-collection.json`),
        filters: { 'Volt Collection': ['volt-collection.json'] },
        saveLabel: 'Export',
        title: 'Export Folder',
      });
      if (!uri) return;

      fs.writeFileSync(uri.fsPath, JSON.stringify(exportObj, null, 2), 'utf8');
      void vscode.window.showInformationMessage(
        `Volt: Folder "${folder}" exported (${requests.length} request${requests.length !== 1 ? 's' : ''})`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in export-folder: ${message}`);
      void vscode.window.showErrorMessage(`Volt: Export failed — ${message}`);
    }
  }

  /**
   * Open a `.volt-request.json` or `.volt-collection.json` file and import
   * the contained requests into the current collection.
   * Name conflicts are resolved by appending `-1`, `-2`, etc.
   */
  private async handleImport(_correlationId: CorrelationId): Promise<void> {
    if (!this.services.collection) {
      void vscode.window.showWarningMessage('Volt: Open a folder to import requests.');
      return;
    }

    try {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Import',
        title: 'Import Volt Request or Collection',
        filters: {
          'Volt Files': ['volt-request.json', 'volt-collection.json'],
          'JSON Files': ['json'],
        },
      });
      if (!uris || uris.length === 0) return;

      const uri = uris[0];
      if (!uri) return;

      const raw = fs.readFileSync(uri.fsPath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        void vscode.window.showErrorMessage('Volt: Invalid JSON in import file.');
        return;
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('type' in (parsed))
      ) {
        void vscode.window.showErrorMessage('Volt: Unrecognised import format (missing "type" field).');
        return;
      }

      const importObj = parsed as Record<string, unknown>;
      const importType = importObj['type'];

      if (importType === 'request') {
        const reqData = importObj['request'] as Record<string, unknown> | undefined;
        if (!reqData || typeof reqData !== 'object') {
          void vscode.window.showErrorMessage('Volt: Import file is missing "request" field.');
          return;
        }

        const baseName = typeof reqData['name'] === 'string' && reqData['name']
          ? reqData['name']
          : 'imported-request';
        const savePath = await this.resolveImportPath(baseName, false);
        await this.saveImportedRequest(savePath, reqData);
        void vscode.window.showInformationMessage(`Volt: Imported request "${baseName}".`);
      } else if (importType === 'collection') {
        const folderName = typeof importObj['folder'] === 'string' ? importObj['folder'] : 'imported';
        const requests = Array.isArray(importObj['requests']) ? importObj['requests'] : [];
        const resolvedFolder = await this.resolveImportPath(folderName, true);

        await this.services.collection.createFolder(resolvedFolder);

        for (const req of requests as unknown[]) {
          if (!req || typeof req !== 'object') continue;
          const r = req as Record<string, unknown>;
          const reqName = typeof r['name'] === 'string' && r['name'] ? r['name'] : 'request';
          const reqPath = `${resolvedFolder}/${reqName}`;
          await this.saveImportedRequest(reqPath, r);
        }

        void vscode.window.showInformationMessage(
          `Volt: Imported collection "${folderName}" (${requests.length} request${requests.length !== 1 ? 's' : ''}).`,
        );
      } else {
        void vscode.window.showErrorMessage(`Volt: Unknown import type "${String(importType)}".`);
        return;
      }

      // Refresh tree so new items appear immediately
      this.treeRefresh?.();

      // Notify webview with updated collection
      try {
        const updatedTree = await this.services.collection.loadTree();
        this.send({ type: 'response:collection', correlationId: `import-${Date.now()}`, payload: updatedTree });
      } catch {
        // Non-critical — tree watcher will pick it up
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in import: ${message}`);
      void vscode.window.showErrorMessage(`Volt: Import failed — ${message}`);
    }
  }

  /**
   * Resolve a name for import, appending `-1`, `-2`, etc. if the path already
   * exists. Works for both request files and folders.
   */
  private async resolveImportPath(baseName: string, isFolder: boolean): Promise<string> {
    // Sanitise name to safe chars (mirrors save-request validation)
    const safeName = baseName.replace(/[^a-zA-Z0-9_/-]/g, '-').replace(/-+/g, '-');

    if (!this.services.collection) return safeName;

    if (isFolder) {
      // Check by loading tree
      const tree = await this.services.collection.loadTree();
      const folderNames = new Set(
        tree.nodes.filter((n) => n.kind === 'folder').map((n) => n.name),
      );
      if (!folderNames.has(safeName)) return safeName;

      let suffix = 1;
      while (folderNames.has(`${safeName}-${suffix}`)) suffix++;
      return `${safeName}-${suffix}`;
    } else {
      // Check by attempting getRequest
      if (!(await this.services.collection.getRequest(safeName))) return safeName;

      let suffix = 1;
      while (await this.services.collection.getRequest(`${safeName}-${suffix}`)) suffix++;
      return `${safeName}-${suffix}`;
    }
  }

  /**
   * Save a raw imported request object as an HttpRequestDef.
   */
  private async saveImportedRequest(
    savePath: string,
    raw: Record<string, unknown>,
  ): Promise<void> {
    if (!this.services.collection) return;

    const method = (typeof raw['method'] === 'string' ? raw['method'] : 'GET') as HttpMethod;
    const url = typeof raw['url'] === 'string' ? raw['url'] : '';
    const name = typeof raw['name'] === 'string' ? raw['name'] : savePath.split('/').pop() ?? savePath;

    const headers: Record<string, string> = {};
    if (raw['headers'] && typeof raw['headers'] === 'object') {
      for (const [k, v] of Object.entries(raw['headers'] as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }

    const queryParams: Array<{ key: string; value: string; enabled: boolean }> = [];
    if (Array.isArray(raw['queryParams'])) {
      for (const p of raw['queryParams'] as unknown[]) {
        if (p && typeof p === 'object') {
          const pp = p as Record<string, unknown>;
          queryParams.push({
            key: String(pp['key'] ?? ''),
            value: String(pp['value'] ?? ''),
            enabled: Boolean(pp['enabled'] ?? true),
          });
        }
      }
    }

    let body: RequestBody | undefined;
    if (raw['body'] && typeof raw['body'] === 'object') {
      const b = raw['body'] as Record<string, unknown>;
      const type = b['type'];
      if (type === 'json' || type === 'text' || type === 'form-data') {
        body = { type, content: typeof b['content'] === 'string' ? b['content'] : '' };
      } else if (type === 'none') {
        body = { type: 'none' };
      }
    }

    const preScript = typeof raw['preScript'] === 'string' ? raw['preScript'] : undefined;
    const postScript = typeof raw['postScript'] === 'string' ? raw['postScript'] : undefined;

    const request: HttpRequestDef = {
      id: savePath,
      name,
      method,
      url,
      headers,
      queryParams,
      ...(body !== undefined ? { body } : {}),
      ...(preScript ? { preScript } : {}),
      ...(postScript ? { postScript } : {}),
    };

    await this.services.collection.saveRequest(savePath, request);
  }

  /**
   * Open a native save dialog and write content to the chosen file.
   * Used by the webview "Save full response" action (REQ-RV-005).
   * When `content` is a file:// URI or an absolute path to an existing file
   * (large body offloaded to temp — H-07), the file is read and its contents
   * are written instead of the path string.
   */
  private async handleSaveToFile(suggestedName: string, content: string): Promise<void> {
    try {
      // H-07: bodyRef case — content may be a file:// URI (large body offloaded to temp)
      let actualContent = content;
      if (content.startsWith('file:///')) {
        actualContent = fs.readFileSync(vscode.Uri.parse(content).fsPath, 'utf8');
      }

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(suggestedName),
        filters: { 'All Files': ['*'] },
      });
      if (!uri) return; // User cancelled

      await vscode.workspace.fs.writeFile(uri, Buffer.from(actualContent, 'utf8'));
      void vscode.window.showInformationMessage(`Volt: Response saved to ${uri.fsPath}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in save-to-file: ${message}`);
      void vscode.window.showErrorMessage(`Volt: Failed to save file — ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // History handlers
  // ---------------------------------------------------------------------------

  /** Return the execution history for a saved request path. */
  private handleGetHistory(correlationId: CorrelationId, requestPath: string): void {
    const entries = this.services.history?.getHistory(requestPath) ?? [];
    this.sendToWebview({
      type: 'response:history',
      correlationId,
      payload: { path: requestPath, entries },
    });
  }

  /** Delete the history file for a saved request path. */
  private handleClearHistory(requestPath: string): void {
    this.services.history?.clearHistory(requestPath);
  }

  /** Delete a single history entry by timestamp. */
  private handleDeleteHistoryEntry(requestPath: string, timestamp: string): void {
    this.services.history?.deleteEntry(requestPath, timestamp);
  }

  // ---------------------------------------------------------------------------
  // Collection Runner handler (Feature 7)
  // ---------------------------------------------------------------------------

  /**
   * Execute all requests in a folder sequentially via `CollectionRunner`.
   * Emits `event:runner-progress` after each request and
   * `event:runner-complete` when all requests have finished.
   */
  private async handleRunCollection(
    correlationId: CorrelationId,
    folder: string,
    delay: number,
  ): Promise<void> {
    if (!this.services.http || !this.services.collection) {
      this.output.appendLine('[MessageRouter] CollectionRunner: http or collection service not available');
      return;
    }

    try {
      const { CollectionRunner } = await import('./services/collection-runner');
      const runner = new CollectionRunner(
        this.output,
        this.services.http,
        this.services.collection,
        this.services.environment,
        this.services.cookies,
      );

      await runner.runFolder(
        folder,
        delay,
        (payload) => {
          this.sendToWebview({
            type: 'event:runner-progress',
            correlationId,
            payload,
          });
        },
        (payload) => {
          this.sendToWebview({
            type: 'event:runner-complete',
            correlationId,
            payload,
          });
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[MessageRouter] ERROR in run-collection: ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Cookie Jar handler (Feature 8)
  // ---------------------------------------------------------------------------

  /** Clear all cookies from the in-memory cookie jar. */
  private handleClearCookies(): void {
    if (this.services.cookies) {
      this.services.cookies.clearAll();
      this.output.appendLine('[MessageRouter] Cookie jar cleared');
    }
  }

  // ---------------------------------------------------------------------------
  // OAuth2 handler
  // ---------------------------------------------------------------------------

  /**
   * Fetch an OAuth2 access token via the `client_credentials` grant flow.
   * POSTs to `tokenUrl` with application/x-www-form-urlencoded credentials.
   * Replies with `response:oauth2-token` containing the token or an error.
   *
   * Note: `authorization_code` requires a browser redirect and callback server.
   * Only `client_credentials` is fully automated here. For `authorization_code`,
   * users should obtain the token externally and paste it into the Access Token
   * field.
   */
  private async handleOAuth2GetToken(
    correlationId: CorrelationId,
    payload: {
      readonly tokenUrl: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scope: string;
      readonly grantType: 'client_credentials' | 'authorization_code';
    },
  ): Promise<void> {
    if (payload.grantType !== 'client_credentials') {
      this.sendToWebview({
        type: 'response:oauth2-token',
        correlationId,
        payload: {
          error:
            'authorization_code flow requires a browser redirect and callback server. ' +
            'Obtain the token externally and paste it into the Access Token field.',
        },
      });
      return;
    }

    try {
      const { fetch } = await import('undici');

      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: payload.clientId,
        client_secret: payload.clientSecret,
        ...(payload.scope ? { scope: payload.scope } : {}),
      });

      const response = await fetch(payload.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        this.sendToWebview({
          type: 'response:oauth2-token',
          correlationId,
          payload: { error: `Token endpoint returned ${response.status}: ${text}` },
        });
        return;
      }

      const json = await response.json() as Record<string, unknown>;

      const accessToken = typeof json['access_token'] === 'string' ? json['access_token'] : '';
      if (!accessToken) {
        this.sendToWebview({
          type: 'response:oauth2-token',
          correlationId,
          payload: { error: 'Token endpoint did not return an access_token field' },
        });
        return;
      }

      const expiresIn =
        typeof json['expires_in'] === 'number' ? json['expires_in'] : undefined;

      this.sendToWebview({
        type: 'response:oauth2-token',
        correlationId,
        payload: { accessToken, ...(expiresIn !== undefined ? { expiresIn } : {}) },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendToWebview({
        type: 'response:oauth2-token',
        correlationId,
        payload: { error: `Failed to fetch token: ${message}` },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // SSE handler
  // ---------------------------------------------------------------------------

  /**
   * Execute a GET request as a Server-Sent Events stream.
   * Pushes `event:sse-event` for each parsed SSE frame and `event:sse-end`
   * when the stream closes. Cancellation uses `request:cancel-http` (same
   * correlationId) because the webview doesn't distinguish SSE from HTTP.
   */
  private async handleSseRequest(
    correlationId: CorrelationId,
    request: HttpRequestDef,
  ): Promise<void> {
    this.output.appendLine(`[MessageRouter] SSE stream starting — ${request.url}`);

    // Build URL with query params (reuse the same buildUrl logic via a minimal wrapper)
    const queryString = request.queryParams
      .filter((p) => p.enabled && p.key.trim() !== '')
      .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
      .join('&');

    const finalUrl = queryString
      ? (request.url.includes('?') ? `${request.url}&${queryString}` : `${request.url}?${queryString}`)
      : request.url;

    const rejectUnauthorized = request.settings?.sslVerify !== false;

    await this.sseService.stream(
      finalUrl,
      { ...request.headers },
      correlationId,
      (sseEvent) => {
        this.sendToWebview({
          type: 'event:sse-event',
          correlationId,
          payload: sseEvent,
        });
      },
      (reason) => {
        this.sendToWebview({
          type: 'event:sse-end',
          correlationId,
          payload: { reason },
        });
        // Also clear loading state
        this.sendToWebview({
          type: 'response:execute-error',
          correlationId,
          payload: { message: `SSE stream ended: ${reason}`, code: 'cancelled' },
        });
      },
      rejectUnauthorized,
    );
  }

  // ---------------------------------------------------------------------------
  // WebSocket handlers
  // ---------------------------------------------------------------------------

  /**
   * Open a WebSocket connection.
   * Environment variable interpolation is applied to the URL before connecting.
   */
  private handleWsConnect(
    correlationId: CorrelationId,
    url: string,
    headers?: Record<string, string>,
  ): void {
    // Interpolate {{variables}} in the URL
    const resolvedUrl = this.services.environment?.resolveRequest
      ? (this.services.environment.resolveRequest({
          id: '',
          method: 'GET',
          url,
          headers: headers ?? {},
          queryParams: [],
        }).url)
      : url;

    this.wsCorrelationId = correlationId;

    // Dispose previous service if it exists
    this.wsService?.dispose();
    this.wsService = new WebSocketService(
      this.output,
      // onConnected
      (connectedUrl: string) => {
        this.sendToWebview({
          type: 'event:ws-connected',
          correlationId,
          payload: { url: connectedUrl },
        });
      },
      // onMessage
      (msg) => {
        this.sendToWebview({
          type: 'event:ws-message',
          correlationId,
          payload: msg,
        });
      },
      // onDisconnected
      (code: number, reason: string) => {
        this.sendToWebview({
          type: 'event:ws-disconnected',
          correlationId,
          payload: { code, reason },
        });
      },
      // onError
      (message: string) => {
        this.sendToWebview({
          type: 'event:ws-error',
          correlationId,
          payload: { message },
        });
      },
    );

    this.wsService.connect(resolvedUrl, headers);
  }

  /** Forward a text frame to the open WebSocket. */
  private handleWsSend(message: string): void {
    if (!this.wsService) {
      this.output.appendLine('[MessageRouter] ws-send: no active WebSocket connection');
      return;
    }
    this.wsService.send(message);
  }

  /** Close the active WebSocket connection. */
  private handleWsDisconnect(): void {
    if (!this.wsService) {
      this.output.appendLine('[MessageRouter] ws-disconnect: no active WebSocket connection');
      return;
    }
    this.wsService.disconnect();
  }

  /**
   * Forward the webview's dirty state to whoever subscribed
   * (`WebviewProvider` uses it for the panel title + on-close warning).
   */
  private handleSetDirty(dirty: boolean): void {
    this.onDirtyStateChanged?.(dirty);
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
    // Clean up WebSocket and SSE services
    this.wsService?.dispose();
    this.wsService = null;
    this.sseService.dispose();
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

// ---------------------------------------------------------------------------
// Auth injection helper
// ---------------------------------------------------------------------------

/**
 * Inject authentication headers or query parameters into a request AFTER
 * environment variable interpolation. Returns a new `HttpRequestDef` with
 * the auth applied; the original is never mutated.
 *
 * Supported schemes:
 * - Bearer:  `Authorization: Bearer <token>`
 * - Basic:   `Authorization: Basic <base64(username:password)>`
 * - API Key: header `<key>: <value>` OR query param `<key>=<value>`
 * - OAuth2:  `Authorization: Bearer <accessToken>` (uses stored token)
 * - AWS:     SigV4 — Authorization + X-Amz-Date headers (see aws-sigv4.ts)
 */
function applyAuth(
  request: HttpRequestDef,
): HttpRequestDef {
  const auth = request.auth;
  if (!auth || auth.type === 'none') return request;

  switch (auth.type) {
    case 'bearer': {
      const headers = { ...request.headers, Authorization: `Bearer ${auth.token}` };
      return { ...request, headers };
    }

    case 'basic': {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      const headers = { ...request.headers, Authorization: `Basic ${encoded}` };
      return { ...request, headers };
    }

    case 'apikey': {
      if (auth.addTo === 'header') {
        const headers = { ...request.headers, [auth.key]: auth.value };
        return { ...request, headers };
      } else {
        // Append as query parameter — preserve existing enabled params
        const extraParam: QueryParam = {
          key: auth.key,
          value: auth.value,
          enabled: true,
        };
        const queryParams = [...request.queryParams, extraParam];
        return { ...request, queryParams };
      }
    }

    case 'oauth2': {
      // Use the stored access token as a Bearer credential
      if (!auth.accessToken) return request;
      const headers = { ...request.headers, Authorization: `Bearer ${auth.accessToken}` };
      return { ...request, headers };
    }

    case 'aws': {
      // AWS SigV4 — sign the request with HMAC-SHA256
      const { signRequest } = require('./utils/aws-sigv4') as typeof AwsSigV4Module;
      const b = request.body;
      const bodyStr =
        b && b.type !== 'none' && b.type !== 'binary' && b.type !== 'graphql'
          ? b.content
          : '';
      const signingHeaders = signRequest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: bodyStr,
        region: auth.region,
        service: auth.service,
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        ...(auth.sessionToken !== undefined ? { sessionToken: auth.sessionToken } : {}),
      });
      const headers = { ...request.headers, ...signingHeaders };
      return { ...request, headers };
    }
  }
}
