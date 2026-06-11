/**
 * @fileoverview Volt WebSocket Service.
 *
 * Manages a single persistent WebSocket connection per panel session using
 * the undici `WebSocket` client (available in Node 18+ via undici's exports).
 * Delegates lifecycle events to callbacks injected at construction time so
 * the message router can forward them to the webview without coupling this
 * service to VS Code APIs.
 *
 * Constraints:
 * - Text frames only (binary frames are not supported in V1).
 * - One connection at a time; calling `connect()` while connected first
 *   disconnects the previous socket.
 * - No automatic reconnection — manual reconnect via the UI.
 */

import { WebSocket } from 'undici';
import type { WsMessage } from '../../shared/models';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Callback signatures
// ---------------------------------------------------------------------------

export type WsConnectedCallback = (url: string) => void;
export type WsMessageCallback = (msg: WsMessage) => void;
export type WsDisconnectedCallback = (code: number, reason: string) => void;
export type WsErrorCallback = (message: string) => void;

// ---------------------------------------------------------------------------
// WebSocketService
// ---------------------------------------------------------------------------

export class WebSocketService implements vscode.Disposable {
  private ws: WebSocket | null = null;
  private readonly output: vscode.OutputChannel;

  private onConnected: WsConnectedCallback;
  private onMessage: WsMessageCallback;
  private onDisconnected: WsDisconnectedCallback;
  private onError: WsErrorCallback;

  constructor(
    output: vscode.OutputChannel,
    onConnected: WsConnectedCallback,
    onMessage: WsMessageCallback,
    onDisconnected: WsDisconnectedCallback,
    onError: WsErrorCallback,
  ) {
    this.output = output;
    this.onConnected = onConnected;
    this.onMessage = onMessage;
    this.onDisconnected = onDisconnected;
    this.onError = onError;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Open a WebSocket connection to `url`.
   * If a connection is already open it is closed first (code 1000).
   *
   * Custom `headers` are passed as HTTP upgrade request headers.
   * The URL supports `{{variable}}` interpolation — callers are responsible for
   * resolving variables before invoking this method.
   */
  connect(url: string, headers?: Record<string, string>): void {
    if (this.ws) {
      this.output.appendLine('[WebSocketService] Closing existing connection before reconnect');
      this.closeSocket(1000, 'Reconnecting');
    }

    this.output.appendLine(`[WebSocketService] Connecting to ${url}`);

    try {
      // undici's WebSocket constructor accepts an options object with `headers`
      const wsOptions: ConstructorParameters<typeof WebSocket>[1] = headers && Object.keys(headers).length > 0
        ? { headers }
        : undefined;

      this.ws = new WebSocket(url, wsOptions);

      this.ws.addEventListener('open', () => {
        this.output.appendLine(`[WebSocketService] Connected — ${url}`);
        this.onConnected(url);
      });

      // undici WebSocket events are typed as plain `Event` in Node context.
      // We cast through `unknown` to extract the concrete payload shapes.
      this.ws.addEventListener('message', (event: Event) => {
        const msgEvent = event as unknown as { data: unknown };
        const data = typeof msgEvent.data === 'string' ? msgEvent.data : String(msgEvent.data);
        const msg: WsMessage = {
          id: generateId(),
          direction: 'received',
          data,
          timestamp: new Date().toISOString(),
        };
        this.onMessage(msg);
      });

      this.ws.addEventListener('close', (event: Event) => {
        const closeEvent = event as unknown as { code: number; reason?: string };
        const code = typeof closeEvent.code === 'number' ? closeEvent.code : 1006;
        const reason = typeof closeEvent.reason === 'string' ? closeEvent.reason : '';
        this.output.appendLine(
          `[WebSocketService] Disconnected — code: ${code}, reason: ${reason || '(none)'}`,
        );
        this.ws = null;
        this.onDisconnected(code, reason);
      });

      this.ws.addEventListener('error', (event: Event) => {
        const errEvent = event as unknown as { message?: string };
        const message = typeof errEvent.message === 'string' ? errEvent.message : 'WebSocket error';
        this.output.appendLine(`[WebSocketService] Error — ${message}`);
        this.onError(message);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[WebSocketService] Failed to create WebSocket — ${message}`);
      this.onError(message);
    }
  }

  /**
   * Send a text frame over the open connection.
   * Silently no-ops when there is no open connection.
   */
  send(message: string): void {
    if (!this.isConnected()) {
      this.output.appendLine('[WebSocketService] WARN: send() called but not connected');
      return;
    }

    try {
      this.ws!.send(message);
      // Echo the sent frame back as a 'sent' WsMessage so the UI log is complete
      const msg: WsMessage = {
        id: generateId(),
        direction: 'sent',
        data: message,
        timestamp: new Date().toISOString(),
      };
      this.onMessage(msg);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[WebSocketService] ERROR sending message — ${errMsg}`);
      this.onError(errMsg);
    }
  }

  /**
   * Close the WebSocket connection with a normal close code (1000).
   * The `onDisconnected` callback fires asynchronously when the close
   * handshake completes.
   */
  disconnect(): void {
    if (!this.ws) {
      this.output.appendLine('[WebSocketService] disconnect() called but not connected');
      return;
    }
    this.closeSocket(1000, 'User disconnected');
  }

  /** Whether the socket is currently open (OPEN state). */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Clean up on panel dispose — forcibly close any open socket without
   * firing the disconnect callback (panel is already gone).
   */
  dispose(): void {
    if (this.ws) {
      // Suppress callbacks — panel is closing
      const noop = (): void => undefined;
      this.onConnected = noop;
      this.onMessage = noop;
      this.onDisconnected = noop;
      this.onError = noop;
      this.closeSocket(1001, 'Panel disposed');
      this.ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return;
    try {
      this.ws.close(code, reason);
    } catch {
      // Swallow — socket may already be closed
    }
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short random ID for WsMessage entries. */
function generateId(): string {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
