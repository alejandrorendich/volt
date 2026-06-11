/**
 * @fileoverview VS Code webview postMessage hook.
 *
 * Wraps the VS Code webview API (acquireVsCodeApi) into a React hook that
 * provides typed message sending and subscription. Implements a 30-second
 * timeout guard for messages expecting a correlating reply.
 *
 * @see src/shared/protocol.ts — HostMessage / WebviewMessage types
 * @see REQ-MSG-004, REQ-MSG-005
 */

import { useEffect, useRef, useCallback } from 'react';
import type { HostMessage, WebviewMessage } from '../../shared/protocol';

// ---------------------------------------------------------------------------
// VS Code API singleton acquisition
// ---------------------------------------------------------------------------

declare function acquireVsCodeApi(): {
  postMessage(msg: HostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

/** Lazily acquire the VS Code webview API — must be called at most once. */
let _vscodeApi: ReturnType<typeof acquireVsCodeApi> | null = null;

function getVsCodeApi(): ReturnType<typeof acquireVsCodeApi> {
  if (!_vscodeApi) {
    _vscodeApi = acquireVsCodeApi();
  }
  return _vscodeApi;
}

// ---------------------------------------------------------------------------
// Pending reply map (correlationId → resolve/reject)
// ---------------------------------------------------------------------------

const MESSAGE_TIMEOUT_MS = 30_000;

interface PendingEntry {
  resolve: (msg: WebviewMessage) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

// ---------------------------------------------------------------------------
// Global window message listener (singleton)
// ---------------------------------------------------------------------------

let globalListenerAttached = false;

function attachGlobalListener(): void {
  if (globalListenerAttached) return;
  globalListenerAttached = true;

  window.addEventListener('message', (event: MessageEvent<{ data: WebviewMessage }>) => {
    const msg = event.data as WebviewMessage;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

    const correlationId = 'correlationId' in msg ? (msg as { correlationId: string }).correlationId : undefined;

    if (correlationId) {
      const entry = pending.get(correlationId);
      if (entry) {
        clearTimeout(entry.timeoutId);
        pending.delete(correlationId);
        entry.resolve(msg);
      }
    }

    // Broadcast to all per-hook subscribers
    window.dispatchEvent(new CustomEvent('volt:message', { detail: msg }));
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseMessageReturn {
  /** Send a message to the extension host. Fire-and-forget. */
  send: (msg: HostMessage) => void;
  /**
   * Send a message and wait for the correlating response.
   * Rejects after MESSAGE_TIMEOUT_MS if no response is received.
   */
  request: (msg: HostMessage & { correlationId: string }) => Promise<WebviewMessage>;
}

/**
 * useMessage — typed postMessage send/subscribe hook.
 *
 * @param onMessage - Optional subscriber invoked for every inbound WebviewMessage.
 *                    Stable reference recommended (useCallback).
 */
export function useMessage(onMessage?: (msg: WebviewMessage) => void): UseMessageReturn {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    attachGlobalListener();

    function handleVoltMessage(event: Event): void {
      const msg = (event as CustomEvent<WebviewMessage>).detail;
      onMessageRef.current?.(msg);
    }

    window.addEventListener('volt:message', handleVoltMessage);
    return () => {
      window.removeEventListener('volt:message', handleVoltMessage);
    };
  }, []);

  const send = useCallback((msg: HostMessage): void => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const request = useCallback(
    (msg: HostMessage & { correlationId: string }): Promise<WebviewMessage> => {
      return new Promise<WebviewMessage>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pending.delete(msg.correlationId);
          reject(new Error(`Message timeout after ${MESSAGE_TIMEOUT_MS}ms (correlationId: ${msg.correlationId})`));
        }, MESSAGE_TIMEOUT_MS);

        pending.set(msg.correlationId, { resolve, reject, timeoutId });
        getVsCodeApi().postMessage(msg);
      });
    },
    [],
  );

  return { send, request };
}
