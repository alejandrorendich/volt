/**
 * @fileoverview WebSocketPanel — UI for WebSocket connections.
 *
 * Renders:
 * - Connection area: URL input + Connect/Disconnect button
 * - Connection status indicator
 * - Message log: scrollable chat-like list (newest at bottom)
 * - Message input + Send button (only when connected)
 *
 * State lives in `useWsStore`; communication uses `useMessage`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useWsStore } from '../stores/ws-store';
import { useMessage } from '../hooks/useMessage';
import './WebSocketPanel.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// WebSocketPanel
// ---------------------------------------------------------------------------

interface WebSocketPanelProps {
  /** Pre-filled URL (comes from the URL bar when ws:// is detected). */
  initialUrl?: string;
  /** Headers to pass on connect (from the request headers table). */
  headers?: Record<string, string>;
}

export function WebSocketPanel({ initialUrl = '', headers = {} }: WebSocketPanelProps): React.ReactElement {
  const status = useWsStore((s) => s.status);
  const connectedUrl = useWsStore((s) => s.connectedUrl);
  const messages = useWsStore((s) => s.messages);
  const errorMessage = useWsStore((s) => s.errorMessage);
  const closeCode = useWsStore((s) => s.closeCode);
  const closeReason = useWsStore((s) => s.closeReason);
  const setConnecting = useWsStore((s) => s.setConnecting);
  const clearMessages = useWsStore((s) => s.clearMessages);

  const [url, setUrl] = useState(initialUrl);
  const [messageText, setMessageText] = useState('');

  const { send } = useMessage();
  const logRef = useRef<HTMLDivElement>(null);
  const sendInputRef = useRef<HTMLTextAreaElement>(null);

  // Keep URL in sync with parent (e.g. when user edits the URL bar)
  useEffect(() => {
    if (initialUrl && status === 'idle') {
      setUrl(initialUrl);
    }
  }, [initialUrl, status]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';
  const canConnect = !isConnected && !isConnecting && url.trim() !== '';

  const handleConnect = useCallback(() => {
    if (!url.trim()) return;
    setConnecting(url.trim());
    send({
      type: 'request:ws-connect',
      correlationId: `ws-connect-${Date.now()}`,
      payload: {
        url: url.trim(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    });
  }, [url, headers, send, setConnecting]);

  const handleDisconnect = useCallback(() => {
    send({
      type: 'request:ws-disconnect',
      correlationId: `ws-disconnect-${Date.now()}`,
    });
  }, [send]);

  const handleSendMessage = useCallback(() => {
    const msg = messageText.trim();
    if (!msg || !isConnected) return;
    send({
      type: 'request:ws-send',
      correlationId: `ws-send-${Date.now()}`,
      payload: { message: msg },
    });
    setMessageText('');
    sendInputRef.current?.focus();
  }, [messageText, isConnected, send]);

  const handleMessageKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+Enter or Cmd+Enter sends the message
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSendMessage();
      }
    },
    [handleSendMessage],
  );

  const handleUrlKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && canConnect) {
        handleConnect();
      }
    },
    [canConnect, handleConnect],
  );

  const handleClear = useCallback(() => {
    clearMessages();
  }, [clearMessages]);

  // ---------------------------------------------------------------------------
  // Status indicator text + class
  // ---------------------------------------------------------------------------
  const statusInfo = {
    idle: { label: 'Disconnected', cls: 'wsp-status--idle' },
    connecting: { label: 'Connecting…', cls: 'wsp-status--connecting' },
    connected: { label: `Connected — ${connectedUrl}`, cls: 'wsp-status--connected' },
    disconnected: { label: `Closed (${closeCode ?? ''}) ${closeReason ? `— ${closeReason}` : ''}`.trim(), cls: 'wsp-status--disconnected' },
    error: { label: `Error${errorMessage ? `: ${errorMessage}` : ''}`, cls: 'wsp-status--error' },
  } as const;

  const { label: statusLabel, cls: statusCls } = statusInfo[status];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="wsp-root">
      {/* Connection bar */}
      <div className="wsp-toolbar">
        <span className={`wsp-status-dot ${statusCls}`} aria-hidden="true" />
        <input
          type="text"
          className="wsp-url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleUrlKeyDown}
          placeholder="ws://localhost:8080 or wss://echo.websocket.org"
          aria-label="WebSocket URL"
          disabled={isConnected || isConnecting}
          spellCheck={false}
        />
        {isConnected ? (
          <button
            type="button"
            className="wsp-btn wsp-btn--disconnect"
            onClick={handleDisconnect}
            aria-label="Disconnect WebSocket"
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="wsp-btn wsp-btn--connect"
            onClick={handleConnect}
            disabled={!canConnect}
            aria-label="Connect WebSocket"
          >
            {isConnecting ? 'Connecting…' : 'Connect'}
          </button>
        )}
        <button
          type="button"
          className="wsp-btn wsp-btn--clear"
          onClick={handleClear}
          disabled={messages.length === 0}
          aria-label="Clear message log"
          title="Clear log"
        >
          Clear
        </button>
      </div>

      {/* Status bar */}
      <div className={`wsp-status-bar ${statusCls}`} role="status" aria-live="polite">
        <span className={`wsp-status-indicator`} aria-hidden="true" />
        {statusLabel}
      </div>

      {/* Message log */}
      <div className="wsp-log" ref={logRef} aria-label="WebSocket message log" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="wsp-log__empty">
            {status === 'idle' || status === 'disconnected' || status === 'error'
              ? 'Connect to start receiving messages'
              : 'Waiting for messages…'}
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`wsp-msg wsp-msg--${msg.direction}`}
              role="listitem"
            >
              <div className="wsp-msg__meta">
                <span className={`wsp-msg__direction wsp-msg__direction--${msg.direction}`} aria-label={msg.direction}>
                  {msg.direction === 'sent' ? '▲ sent' : '▼ recv'}
                </span>
                <span className="wsp-msg__timestamp">{formatTimestamp(msg.timestamp)}</span>
              </div>
              <pre className="wsp-msg__data">{msg.data}</pre>
            </div>
          ))
        )}
      </div>

      {/* Message input */}
      <div className={`wsp-input-area${!isConnected ? ' wsp-input-area--disabled' : ''}`}>
        <textarea
          ref={sendInputRef}
          className="wsp-message-input"
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
          onKeyDown={handleMessageKeyDown}
          placeholder={isConnected ? 'Type a message… (Ctrl+Enter to send)' : 'Connect first to send messages'}
          disabled={!isConnected}
          rows={3}
          aria-label="Message to send"
          spellCheck={false}
        />
        <div className="wsp-input-actions">
          <button
            type="button"
            className="wsp-btn wsp-btn--send"
            onClick={handleSendMessage}
            disabled={!isConnected || messageText.trim() === ''}
            aria-label="Send message"
          >
            Send
          </button>
          <span className="wsp-hint">Ctrl+Enter</span>
        </div>
      </div>
    </div>
  );
}
