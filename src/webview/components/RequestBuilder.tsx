/**
 * @fileoverview RequestBuilder — HTTP request composition UI.
 *
 * Renders: method selector, URL input with {{var}} highlighting,
 * tabbed sub-panels (Params, Headers, Body), Send/Cancel button.
 *
 * Communicates with the extension host via `useMessage`.
 * All state lives in `useRequestStore` and `useResponseStore`.
 *
 * @see REQ-RB-001 through REQ-RB-006
 */

import React, { useCallback, useEffect, useId, useRef, memo, useState } from 'react';
import { useRequestStore } from '../stores/request-store';
import type { RequestState } from '../stores/request-store';
import { useResponseStore } from '../stores/response-store';
import { useHistoryStore } from '../stores/history-store';
import { useWsStore } from '../stores/ws-store';
import { useSseStore } from '../stores/sse-store';
import { useMessage } from '../hooks/useMessage';
import { KeyValueEditor } from './KeyValueEditor';
import { AssertionsPanel } from './AssertionsPanel';
import { CodegenPanel } from './CodegenPanel';
import { AuthPanel } from './AuthPanel';
import type { HttpMethod, RequestBody } from '../../shared/models';
import type { HistoryEntry } from '../../shared/protocol';
import './RequestBuilder.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const BODY_DISABLED_METHODS: HttpMethod[] = ['GET', 'HEAD'];

const COMMON_HEADERS = [
  'Accept',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'If-None-Match',
  'Origin',
  'User-Agent',
  'X-Api-Key',
  'X-Request-Id',
];

const BODY_TYPES: Array<RequestBody['type']> = ['none', 'json', 'text', 'form-data', 'binary', 'graphql'];

const BODY_TYPE_LABELS: Record<RequestBody['type'], string> = {
  none: 'None',
  json: 'JSON',
  text: 'Text',
  'form-data': 'Form Data',
  binary: 'Binary',
  graphql: 'GraphQL',
};

// ---------------------------------------------------------------------------
// HistoryPanel — execution history for saved requests
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp as a human-readable relative time string.
 * E.g. "2 min ago", "just now", "3 hr ago".
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return 'rb-history__status--success';
  if (status >= 300 && status < 400) return 'rb-history__status--redirect';
  return 'rb-history__status--error';
}

interface HistoryPanelProps {
  requestPath: string;
}

const HistoryPanel = memo(function HistoryPanel({ requestPath }: HistoryPanelProps): React.ReactElement {
  const { send } = useMessage();
  const setHistory = useHistoryStore((s) => s.setHistory);
  const clearHistoryStore = useHistoryStore((s) => s.clearHistory);
  const entries = useHistoryStore((s) => s.getHistory(requestPath));

  // Load history from host on mount (and when requestPath changes)
  useEffect(() => {
    send({
      type: 'request:get-history',
      correlationId: `get-history-${Date.now()}`,
      payload: { path: requestPath },
    });
  }, [requestPath, send]);

  const handleClear = useCallback(() => {
    send({
      type: 'request:clear-history',
      correlationId: `clear-history-${Date.now()}`,
      payload: { path: requestPath },
    });
    clearHistoryStore(requestPath);
    setHistory(requestPath, []);
  }, [requestPath, send, clearHistoryStore, setHistory]);

  const handleEntryClick = useCallback((entry: HistoryEntry) => {
    const responseStore = useResponseStore.getState();
    responseStore.setResponse({
      requestId: requestPath,
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers ?? {},
      body: entry.body ?? '',
      bodySize: entry.body?.length ?? 0,
      timing: { dns: 0, tcp: 0, tls: 0, ttfb: 0, body: 0, total: entry.time },
    });
  }, [requestPath]);

  const handleDeleteEntry = useCallback((timestamp: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger the row click
    send({
      type: 'request:delete-history-entry',
      correlationId: `delete-entry-${Date.now()}`,
      payload: { path: requestPath, timestamp },
    });
    // Optimistic update — remove from local store
    const current = useHistoryStore.getState().getHistory(requestPath);
    setHistory(requestPath, current.filter((entry) => entry.timestamp !== timestamp));
  }, [requestPath, send, setHistory]);

  if (entries.length === 0) {
    return (
      <div className="rb-history rb-history--empty">
        <span className="rb-history__empty-icon" aria-hidden="true">🕐</span>
        <span className="rb-history__empty-text">No executions yet — send a request to start logging</span>
      </div>
    );
  }

  return (
    <div className="rb-history">
      <div className="rb-history__list" role="list" aria-label="Request execution history">
        {(entries as HistoryEntry[]).map((entry, i) => (
          <div
            key={`${entry.timestamp}-${i}`}
            className="rb-history__entry"
            role="listitem"
            onClick={() => handleEntryClick(entry)}
            title="Click to view in response panel"
          >
            <span className={`rb-history__status ${statusClass(entry.status)}`} aria-label={`Status ${entry.status}`}>
              {entry.status}
            </span>
            <span className="rb-history__method" aria-label={`Method ${entry.method}`}>
              {entry.method}
            </span>
            <span className="rb-history__url" title={entry.url} aria-label="URL">
              {entry.url.length > 60 ? `…${entry.url.slice(-57)}` : entry.url}
            </span>
            <span className="rb-history__time" aria-label={`Response time ${entry.time}ms`}>
              {entry.time}ms
            </span>
            <span className="rb-history__timestamp" title={entry.timestamp} aria-label={`Executed ${relativeTime(entry.timestamp)}`}>
              {relativeTime(entry.timestamp)}
            </span>
            <button
              type="button"
              className="rb-history__delete-btn"
              onClick={(e) => handleDeleteEntry(entry.timestamp, e)}
              aria-label="Delete this entry"
              title="Delete"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="rb-history__footer">
        <button
          type="button"
          className="rb-history__clear-btn"
          onClick={handleClear}
          aria-label="Clear execution history"
        >
          Clear History
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Script editor — pre/post request scripts
// ---------------------------------------------------------------------------

function ScriptEditor(): React.ReactElement {
  const preScript = useRequestStore((s) => s.preScript);
  const postScript = useRequestStore((s) => s.postScript);
  const setPreScript = useRequestStore((s) => s.setPreScript);
  const setPostScript = useRequestStore((s) => s.setPostScript);
  const scriptError = useRequestStore((s) => s.scriptError);

  return (
    <div className="rb-scripts">
      {scriptError && (
        <div className="rb-scripts__error" role="alert" aria-live="assertive">
          <span className="rb-scripts__error-icon" aria-hidden="true">⚠</span>
          <div className="rb-scripts__error-body">
            <span className="rb-scripts__error-phase">
              {scriptError.phase === 'pre' ? 'Pre-request' : 'Post-request'} script error
            </span>
            <span className="rb-scripts__error-message">{scriptError.message}</span>
          </div>
        </div>
      )}
      <div className="rb-scripts__section">
        <label className="rb-scripts__label">Pre-request Script</label>
        <textarea
          className="rb-scripts__editor"
          value={preScript}
          onChange={(e) => setPreScript(e.target.value)}
          placeholder={`// Runs before the request is sent\n// Available: request, env.get(), env.set(), console.log()`}
          spellCheck={false}
          rows={5}
        />
      </div>
      <div className="rb-scripts__section">
        <label className="rb-scripts__label">Post-request Script</label>
        <textarea
          className="rb-scripts__editor"
          value={postScript}
          onChange={(e) => setPostScript(e.target.value)}
          placeholder={`// Runs after the response is received\n// Available: response, json, env.get(), env.set(), console.log()\n\n// Example: save token to environment\n// const data = json;\n// env.set("token", data.access_token);`}
          spellCheck={false}
          rows={8}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save button — shows dirty state, triggers manual save via useSaveRequest hook
// ---------------------------------------------------------------------------

function SaveButton(): React.ReactElement {
  const savePath = useRequestStore((s) => s.savePath);
  const tabs = useRequestStore((s) => s.tabs);
  const activeTabId = useRequestStore((s) => s.activeTabId);
  const { send } = useMessage();

  const currentTab = tabs.find((t) => t.tabId === activeTabId);
  const isDirty = currentTab?.dirty ?? false;

  const handleSave = useCallback(() => {
    const s = useRequestStore.getState();
    const def = s.toRequestDef();

    if (!s.savePath) {
      // No file yet — send with empty path; host will prompt for name
      send({
        type: 'request:save-request',
        correlationId: `save-new-${Date.now()}`,
        payload: { path: '', request: def },
      });
      return;
    }

    send({
      type: 'request:save-request',
      correlationId: `save-${Date.now()}`,
      payload: { path: s.savePath, request: def },
    });
    // markSaved() is NOT called here — it is called in App.tsx when the host
    // confirms success via response:request-saved (C-03).
  }, [send]);

  return (
    <button
      type="button"
      className={`rb-save${isDirty || !savePath ? ' rb-save--dirty' : ''}`}
      onClick={handleSave}
      aria-label="Save request (Ctrl+S)"
      title="Save (Ctrl+S)"
    >
      {!savePath ? 'Save' : isDirty ? 'Save •' : 'Saved'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// URL input with {{var}} highlight overlay
// ---------------------------------------------------------------------------

function UrlInput(): React.ReactElement {
  const url = useRequestStore((s) => s.url);
  const setUrl = useRequestStore((s) => s.setUrl);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value),
    [setUrl],
  );

  // Split URL into parts for highlight overlay
  const parts = url.split(/({{[^}]+}})/g);

  return (
    <div className="rb-url-wrap">
      {/* Highlight overlay (decorative) */}
      <div className="rb-url-highlight" aria-hidden="true">
        {parts.map((part, i) =>
          part.startsWith('{{') && part.endsWith('}}') ? (
            <mark key={i} className="rb-url-var">
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </div>

      <input
        type="text"
        className="rb-url-input"
        value={url}
        onChange={handleChange}
        placeholder="https://api.example.com/endpoint"
        spellCheck={false}
        autoComplete="off"
        aria-label="Request URL"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Binary body picker (REQ-RB-004)
// Uses a host-side file picker so the full OS path is available to the
// extension host when building the request body (C-01).
// ---------------------------------------------------------------------------

interface BinaryBodyPickerProps {
  filePath: string;
  onFilePathChange: (path: string, name: string) => void;
}

const BinaryBodyPicker = memo(function BinaryBodyPicker({
  filePath,
  onFilePathChange,
}: BinaryBodyPickerProps): React.ReactElement {
  const { request } = useMessage();
  const [picking, setPicking] = useState(false);

  const handleChoose = useCallback(async () => {
    if (picking) return;
    setPicking(true);
    try {
      const correlationId = `pick-binary-${Date.now()}`;
      const reply = await request({
        type: 'request:pick-binary-file',
        correlationId,
      });
      if (reply.type === 'response:binary-file-picked' && reply.payload) {
        onFilePathChange(reply.payload.path, reply.payload.name);
      }
    } catch {
      // User cancelled or timeout — do nothing
    } finally {
      setPicking(false);
    }
  }, [request, onFilePathChange, picking]);

  // Display just the filename portion for readability
  const displayName = filePath ? filePath.split(/[\\/]/).pop() ?? filePath : '';

  return (
    <div className="rb-body-binary">
      <button
        type="button"
        className="rb-body-binary__btn"
        onClick={() => void handleChoose()}
        disabled={picking}
        aria-label="Choose file for binary body"
      >
        📂 {picking ? 'Opening…' : 'Choose file'}
      </button>
      {displayName ? (
        <span className="rb-body-binary__path" title={filePath}>
          {displayName}
        </span>
      ) : (
        <span className="rb-body-binary__placeholder">No file selected</span>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Body editor
// ---------------------------------------------------------------------------

interface BodyEditorProps {
  method: HttpMethod;
}

const BodyEditor = memo(function BodyEditor({ method }: BodyEditorProps): React.ReactElement {
  const body = useRequestStore((s) => s.body);
  const setBody = useRequestStore((s) => s.setBody);

  // Form-data rows are separate from HTTP headers (C-02)
  const formDataRows = useRequestStore((s) => s.formDataRows);
  const addFormRow = useRequestStore((s) => s.addFormRow);
  const updateFormRow = useRequestStore((s) => s.updateFormRow);
  const removeFormRow = useRequestStore((s) => s.removeFormRow);

  const bodyDisabled = BODY_DISABLED_METHODS.includes(method);
  const bodyTextareaId = useId();

  const [jsonError, setJsonError] = React.useState<string | null>(null);

  const handleTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const t = e.target.value as RequestBody['type'];
      if (t === 'none') {
        setBody({ type: 'none' });
      } else if (t === 'form-data') {
        setBody({ type: 'form-data', content: '' });
      } else if (t === 'binary') {
        setBody({ type: 'binary', filePath: '' });
      } else if (t === 'graphql') {
        setBody({ type: 'graphql', query: '', variables: '{}', operationName: '' });
      } else {
        setBody({ type: t as 'json' | 'text', content: (body as { content?: string }).content ?? '' });
      }
      setJsonError(null);
    },
    [body, setBody],
  );

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const content = e.target.value;
      if (body.type === 'json' || body.type === 'text') {
        setBody({ type: body.type, content });
      }
      if (body.type === 'json') {
        // Validate JSON on change
        try {
          if (content.trim() !== '') JSON.parse(content);
          setJsonError(null);
        } catch (err) {
          setJsonError((err as Error).message);
        }
      }
    },
    [body, setBody],
  );

  if (bodyDisabled) {
    return (
      <div className="rb-body-disabled">
        <span className="rb-body-disabled__icon" aria-hidden="true">⊘</span>
        <span>Body not available for {method} requests</span>
      </div>
    );
  }

  return (
    <div className="rb-body">
      {/* Type selector */}
      <div className="rb-body-type-bar">
        {BODY_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`rb-body-type-btn${body.type === t ? ' rb-body-type-btn--active' : ''}`}
            onClick={() => {
              if (t === 'none') setBody({ type: 'none' });
              else if (t === 'binary') setBody({ type: 'binary', filePath: (body as { filePath?: string }).filePath ?? '' });
              else if (t === 'graphql') setBody({ type: 'graphql', query: '', variables: '{}', operationName: '' });
              else setBody({ type: t as 'json' | 'text' | 'form-data', content: '' });
            }}
            aria-pressed={body.type === t}
          >
            {BODY_TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Editor area */}
      {body.type === 'none' && (
        <div className="rb-body-none">No body</div>
      )}

      {(body.type === 'json' || body.type === 'text') && (
        <div className="rb-body-raw">
          <textarea
            id={bodyTextareaId}
            className={`rb-body-textarea volt-monospace${jsonError ? ' rb-body-textarea--error' : ''}`}
            value={body.content}
            onChange={handleContentChange}
            placeholder={body.type === 'json' ? '{\n  \n}' : 'Request body…'}
            spellCheck={false}
            aria-label={body.type === 'json' ? 'JSON body' : 'Text body'}
          />
          {jsonError && (
            <div className="rb-body-json-error" role="alert">
              <span className="rb-body-json-error__icon" aria-hidden="true">⚠</span>
              {jsonError}
            </div>
          )}
        </div>
      )}

      {body.type === 'form-data' && (
        <KeyValueEditor
          rows={formDataRows}
          onAdd={addFormRow}
          onUpdate={updateFormRow}
          onRemove={removeFormRow}
          keyPlaceholder="Field name"
          valuePlaceholder="Value"
        />
      )}

      {body.type === 'binary' && (
        <BinaryBodyPicker
          filePath={body.filePath}
          onFilePathChange={(fp) => setBody({ type: 'binary', filePath: fp })}
        />
      )}

      {body.type === 'graphql' && (
        <div className="rb-body-graphql">
          <div className="rb-body-graphql__field">
            <label className="rb-body-graphql__label" htmlFor={`${bodyTextareaId}-query`}>Query</label>
            <textarea
              id={`${bodyTextareaId}-query`}
              className="rb-body-graphql__query volt-monospace"
              value={body.query}
              onChange={(e) => setBody({ type: 'graphql', query: e.target.value, variables: body.variables, operationName: body.operationName })}
              placeholder={'query {\n  \n}'}
              spellCheck={false}
              rows={12}
              aria-label="GraphQL query"
            />
          </div>
          <div className="rb-body-graphql__field">
            <label className="rb-body-graphql__label" htmlFor={`${bodyTextareaId}-vars`}>Variables</label>
            <textarea
              id={`${bodyTextareaId}-vars`}
              className="rb-body-graphql__variables volt-monospace"
              value={body.variables}
              onChange={(e) => setBody({ type: 'graphql', query: body.query, variables: e.target.value, operationName: body.operationName })}
              placeholder={'{\n  \n}'}
              spellCheck={false}
              rows={5}
              aria-label="GraphQL variables (JSON)"
            />
          </div>
          <div className="rb-body-graphql__field">
            <label className="rb-body-graphql__label" htmlFor={`${bodyTextareaId}-opname`}>Operation Name</label>
            <input
              id={`${bodyTextareaId}-opname`}
              type="text"
              className="rb-body-graphql__opname"
              value={body.operationName}
              onChange={(e) => setBody({ type: 'graphql', query: body.query, variables: body.variables, operationName: e.target.value })}
              placeholder="Optional — for multi-operation documents"
              aria-label="GraphQL operation name"
            />
          </div>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// RequestBuilder
// ---------------------------------------------------------------------------

/** Short labels used in the Auth tab badge. */
const AUTH_TYPE_BADGE_LABELS: Record<'bearer' | 'basic' | 'apikey' | 'oauth2' | 'aws', string> = {
  bearer: 'Bearer',
  basic: 'Basic',
  apikey: 'API Key',
  oauth2: 'OAuth2',
  aws: 'AWS',
};

export const RequestBuilder = memo(function RequestBuilder(): React.ReactElement {
  const method = useRequestStore((s) => s.method);
  const setMethod = useRequestStore((s) => s.setMethod);
  const activeTab = useRequestStore((s) => s.activeTab);
  const setActiveTab = useRequestStore((s) => s.setActiveTab);
  const loading = useRequestStore((s) => s.loading);
  const setLoading = useRequestStore((s) => s.setLoading);
  const activeCorrelationId = useRequestStore((s) => s.activeCorrelationId);
  const url = useRequestStore((s) => s.url);
  const toRequestDef = useRequestStore((s) => s.toRequestDef);
  const streamingPhase = useRequestStore((s) => s.streamingPhase);
  const savePath = useRequestStore((s) => s.savePath);
  const sslVerify = useRequestStore((s) => s.sslVerify);
  const setSslVerify = useRequestStore((s) => s.setSslVerify);
  const followRedirects = useRequestStore((s) => s.followRedirects);
  const setFollowRedirects = useRequestStore((s) => s.setFollowRedirects);
  const timeout = useRequestStore((s) => s.timeout);
  const setTimeoutValue = useRequestStore((s) => s.setTimeout);
  const auth = useRequestStore((s) => s.auth);

  // History tab state — local to avoid touching store snapshot machinery
  const [activeLocalTab, setActiveLocalTab] = useState<'store' | 'history'>('store');

  const historyEntries = useHistoryStore((s) => s.getHistory(savePath ?? ''));
  const historyCount = savePath ? historyEntries.length : 0;

  // Headers
  const headers = useRequestStore((s) => s.headers);
  const addHeader = useRequestStore((s) => s.addHeader);
  const updateHeader = useRequestStore((s) => s.updateHeader);
  const removeHeader = useRequestStore((s) => s.removeHeader);

  // Query params
  const queryParams = useRequestStore((s) => s.queryParams);
  const addParam = useRequestStore((s) => s.addParam);
  const updateParam = useRequestStore((s) => s.updateParam);
  const removeParam = useRequestStore((s) => s.removeParam);
  const body = useRequestStore((s) => s.body);
  const preScript = useRequestStore((s) => s.preScript);
  const postScript = useRequestStore((s) => s.postScript);
  const scriptError = useRequestStore((s) => s.scriptError);

  const setResponse = useResponseStore((s) => s.setLoading);

  const wsStatus = useWsStore((s) => s.status);
  const wsSetConnecting = useWsStore((s) => s.setConnecting);
  const wsReset = useWsStore((s) => s.reset);
  const sseStartStreaming = useSseStore((s) => s.startStreaming);

  const { send } = useMessage();

  const correlationIdRef = useRef<string>('');

  // Detect WS mode from the current URL
  const isWsMode = /^wss?:\/\//i.test(url.trim());
  const wsConnected = wsStatus === 'connected';
  const wsConnecting = wsStatus === 'connecting';

  // Convert queryParams to KVRow for KeyValueEditor
  const paramRows = queryParams.map((p, i) => ({ id: `param-${i}`, key: p.key, value: p.value, enabled: p.enabled }));

  const handleParamUpdate = useCallback(
    (id: string, patch: Partial<{ key: string; value: string; enabled: boolean }>) => {
      const index = parseInt(id.replace('param-', ''), 10);
      updateParam(index, patch);
    },
    [updateParam],
  );

  const handleParamRemove = useCallback(
    (id: string) => {
      const index = parseInt(id.replace('param-', ''), 10);
      removeParam(index);
    },
    [removeParam],
  );

  const handleSend = useCallback(() => {
    // WebSocket mode
    if (isWsMode) {
      if (wsConnected) {
        // Disconnect
        send({
          type: 'request:ws-disconnect',
          correlationId: `ws-disconnect-${Date.now()}`,
        });
      } else if (!wsConnecting) {
        // Connect
        const wsHeaders: Record<string, string> = {};
        for (const h of headers) {
          if (h.enabled && h.key.trim() !== '') wsHeaders[h.key.trim()] = h.value;
        }
        wsSetConnecting(url.trim());
        send({
          type: 'request:ws-connect',
          correlationId: `ws-connect-${Date.now()}`,
          payload: {
            url: url.trim(),
            ...(Object.keys(wsHeaders).length > 0 ? { headers: wsHeaders } : {}),
          },
        });
      }
      return;
    }

    // Normal HTTP (including SSE)
    if (loading) {
      // Cancel — only send the cancel message; do NOT call setLoading here.
      // The host will respond with response:execute-error { code: 'cancelled' }
      // which drives the state transition back to non-loading (H-02).
      if (activeCorrelationId) {
        send({
          type: 'request:cancel-http',
          correlationId: `cancel-${Date.now()}`,
          payload: { id: activeCorrelationId },
        });
      }
      return;
    }

    const requestDef = toRequestDef();
    const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    correlationIdRef.current = correlationId;

    // Detect SSE: Accept header contains text/event-stream
    const acceptHeader =
      requestDef.headers['Accept'] ??
      requestDef.headers['accept'] ??
      '';
    if (acceptHeader.includes('text/event-stream')) {
      sseStartStreaming();
    }

    setLoading(true, correlationId);
    setResponse();

    send({
      type: 'request:execute-http',
      correlationId,
      payload: requestDef,
    });
  }, [isWsMode, wsConnected, wsConnecting, loading, activeCorrelationId, send, setLoading, toRequestDef, setResponse, url, headers, wsSetConnecting, sseStartStreaming]);

  // Keyboard: Enter in URL sends, Escape cancels
  const handleUrlKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && url.trim() !== '') {
        handleSend();
      }
      if (e.key === 'Escape' && loading) {
        handleSend();
      }
    },
    [handleSend, loading, url],
  );

  const enabledHeaderCount = headers.filter((h) => h.enabled && h.key.trim() !== '').length;
  const enabledParamCount = queryParams.filter((p) => p.enabled && p.key.trim() !== '').length;
  const hasBody = body.type !== 'none';
  const hasScripts = preScript.trim() !== '' || postScript.trim() !== '';

  // Assertions badge — show pass/fail summary after execution
  const assertions = useRequestStore((s) => s.assertions);
  const assertionResults = useRequestStore((s) => s.assertionResults);
  const assertionPassCount = assertionResults.filter((r) => r.pass).length;
  const assertionTotal = assertionResults.length;
  const hasAssertions = assertions.length > 0;

  // Code generation panel
  const [codegenOpen, setCodegenOpen] = useState(false);

  // When switching away from history tab, restore to store-managed tabs
  const handleStoreTabClick = useCallback(
    (tab: RequestState['activeTab']) => {
      setActiveLocalTab('store');
      setActiveTab(tab);
    },
    [setActiveTab],
  );

  const handleHistoryTabClick = useCallback(() => {
    setActiveLocalTab('history');
  }, []);

  const isHistoryTabActive = activeLocalTab === 'history';
  const isStoreTabActive = (tab: RequestState['activeTab']): boolean =>
    activeLocalTab === 'store' && activeTab === tab;

  // Auth badge — show the active auth type name when not "none"
  const authBadgeLabel = auth.type !== 'none' ? AUTH_TYPE_BADGE_LABELS[auth.type] : null;

  return (
    <div className="rb-root">
      {/* ---- Toolbar row: method + URL + send ---- */}
      <div className="rb-toolbar">
        {/* Method selector */}
        <select
          className="rb-method"
          value={method}
          onChange={(e) => setMethod(e.target.value as HttpMethod)}
          aria-label="HTTP method"
          style={{ '--method-color': `var(--volt-method-${method.toLowerCase()})` } as React.CSSProperties}
        >
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        {/* URL input */}
        <div className="rb-url-container" onKeyDown={handleUrlKeyDown}>
          <UrlInput />
        </div>

        {/* Send / Cancel / WS Connect/Disconnect */}
        <button
          type="button"
          className={`rb-send${(loading || wsConnecting) ? ' rb-send--cancel' : ''}${wsConnected ? ' rb-send--disconnect' : ''}`}
          onClick={handleSend}
          disabled={
            isWsMode
              ? wsConnecting
              : (!loading && url.trim() === '')
          }
          aria-label={
            isWsMode
              ? (wsConnected ? 'Disconnect WebSocket' : wsConnecting ? 'Connecting…' : 'Connect WebSocket')
              : (loading ? 'Cancel request' : 'Send request')
          }
          title={
            isWsMode
              ? (wsConnected ? 'Disconnect' : 'Connect')
              : (loading ? 'Cancel (Esc)' : 'Send (Enter)')
          }
        >
          {isWsMode ? (
            wsConnected ? 'Disconnect' : wsConnecting ? (
              <>
                <span className="rb-send__spinner" aria-hidden="true" />
                Connecting…
              </>
            ) : 'Connect'
          ) : loading ? (
            <>
              <span className="rb-send__spinner" aria-hidden="true" />
              Cancel
            </>
          ) : (
            'Send'
          )}
        </button>

        {/* Save button */}
        <SaveButton />

        {/* Generate Code button */}
        <button
          type="button"
          className="rb-codegen-btn"
          onClick={() => setCodegenOpen(true)}
          aria-label="Generate code snippet"
          title="Generate code (</>)"
        >
          {'</>'}
        </button>

        {/* SSL verification toggle */}
        <label className="rb-ssl-toggle" title="Toggle TLS certificate verification">
          <input
            type="checkbox"
            className="rb-ssl-toggle__checkbox"
            checked={sslVerify}
            onChange={(e) => setSslVerify(e.target.checked)}
            aria-label="Verify SSL certificate"
          />
          <span className="rb-ssl-toggle__label">SSL</span>
        </label>

        {/* Follow Redirects toggle */}
        <label className="rb-ssl-toggle" title="Toggle automatic redirect following">
          <input
            type="checkbox"
            className="rb-ssl-toggle__checkbox"
            checked={followRedirects}
            onChange={(e) => setFollowRedirects(e.target.checked)}
            aria-label="Follow redirects"
          />
          <span className="rb-ssl-toggle__label">Redirects</span>
        </label>

        {/* Timeout input */}
        <label className="rb-timeout-wrap" title="Request timeout in milliseconds (empty = default 30s)">
          <input
            type="number"
            className="rb-timeout-input"
            value={timeout ?? ''}
            min={0}
            step={500}
            onChange={(e) => {
              const val = e.target.value;
              setTimeoutValue(val === '' ? null : Math.max(0, parseInt(val, 10)));
            }}
            placeholder="30000"
            aria-label="Request timeout in milliseconds"
          />
          <span className="rb-ssl-toggle__label">ms</span>
        </label>
      </div>

      {/* Streaming progress indicator (REQ-MSG-003) */}
      {loading && streamingPhase && (
        <div className="rb-streaming-indicator" role="status" aria-live="polite">
          <span className="rb-streaming-indicator__dot" aria-hidden="true" />
          Receiving data… ({streamingPhase})
        </div>
      )}

      {/* ---- Tabs row ---- */}
      <div className="rb-tabs" role="tablist" aria-label="Request options">
        <button
          role="tab"
          type="button"
          className={`rb-tab${isStoreTabActive('params') ? ' rb-tab--active' : ''}`}
          onClick={() => handleStoreTabClick('params')}
          aria-selected={isStoreTabActive('params')}
          aria-controls="rb-panel-params"
        >
          Params {enabledParamCount > 0 && <span className="rb-badge">{enabledParamCount}</span>}
        </button>
        <button
          role="tab"
          type="button"
          className={`rb-tab${isStoreTabActive('headers') ? ' rb-tab--active' : ''}`}
          onClick={() => handleStoreTabClick('headers')}
          aria-selected={isStoreTabActive('headers')}
          aria-controls="rb-panel-headers"
        >
          Headers {enabledHeaderCount > 0 && <span className="rb-badge">{enabledHeaderCount}</span>}
        </button>
        <button
          role="tab"
          type="button"
          className={`rb-tab${isStoreTabActive('body') ? ' rb-tab--active' : ''}`}
          onClick={() => handleStoreTabClick('body')}
          aria-selected={isStoreTabActive('body')}
          aria-controls="rb-panel-body"
        >
          Body {hasBody && <span className="rb-badge rb-badge--type">{body.type}</span>}
        </button>
        <button
          role="tab"
          type="button"
          className={`rb-tab${isStoreTabActive('scripts') ? ' rb-tab--active' : ''}`}
          onClick={() => handleStoreTabClick('scripts')}
          aria-selected={isStoreTabActive('scripts')}
          aria-controls="rb-panel-scripts"
        >
          Scripts{' '}
          {scriptError ? (
            <span className="rb-badge rb-badge--error" aria-label="Script error">⚠</span>
          ) : hasScripts ? (
            <span className="rb-badge">●</span>
          ) : null}
        </button>
        <button
          role="tab"
          type="button"
          className={`rb-tab${isStoreTabActive('tests') ? ' rb-tab--active' : ''}`}
          onClick={() => handleStoreTabClick('tests')}
          aria-selected={isStoreTabActive('tests')}
          aria-controls="rb-panel-tests"
        >
          Tests{' '}
          {assertionTotal > 0 ? (
            <span
              className={`rb-badge${assertionPassCount === assertionTotal ? ' rb-badge--pass' : ' rb-badge--error'}`}
              aria-label={`${assertionPassCount}/${assertionTotal} assertions passed`}
            >
              {assertionPassCount}/{assertionTotal}
            </span>
          ) : hasAssertions ? (
            <span className="rb-badge">{assertions.length}</span>
          ) : null}
        </button>
        <button
          role="tab"
          type="button"
          className={`rb-tab${isStoreTabActive('auth') ? ' rb-tab--active' : ''}`}
          onClick={() => handleStoreTabClick('auth')}
          aria-selected={isStoreTabActive('auth')}
          aria-controls="rb-panel-auth"
        >
          Auth{' '}
          {authBadgeLabel && (
            <span className="rb-badge rb-badge--auth" aria-label={`Auth type: ${authBadgeLabel}`}>
              {authBadgeLabel}
            </span>
          )}
        </button>
        {savePath !== null && (
          <button
            role="tab"
            type="button"
            className={`rb-tab${isHistoryTabActive ? ' rb-tab--active' : ''}`}
            onClick={handleHistoryTabClick}
            aria-selected={isHistoryTabActive}
            aria-controls="rb-panel-history"
          >
            History{' '}
            {historyCount > 0 && <span className="rb-badge">{historyCount}</span>}
          </button>
        )}
      </div>

      {/* ---- Panel content ---- */}
      <div className="rb-panel-area">
        <div
          id="rb-panel-params"
          role="tabpanel"
          aria-label="Query parameters"
          hidden={!isStoreTabActive('params')}
          className="rb-panel"
        >
          <KeyValueEditor
            rows={paramRows}
            onAdd={addParam}
            onUpdate={handleParamUpdate}
            onRemove={handleParamRemove}
            keyPlaceholder="Parameter"
            valuePlaceholder="Value"
          />
        </div>

        <div
          id="rb-panel-headers"
          role="tabpanel"
          aria-label="Request headers"
          hidden={!isStoreTabActive('headers')}
          className="rb-panel"
        >
          <KeyValueEditor
            rows={headers}
            onAdd={addHeader}
            onUpdate={updateHeader}
            onRemove={removeHeader}
            keyPlaceholder="Header"
            valuePlaceholder="Value"
            keySuggestions={COMMON_HEADERS}
          />
        </div>

        <div
          id="rb-panel-body"
          role="tabpanel"
          aria-label="Request body"
          hidden={!isStoreTabActive('body')}
          className="rb-panel"
        >
          <BodyEditor method={method} />
        </div>

        <div
          id="rb-panel-scripts"
          role="tabpanel"
          aria-label="Pre and post request scripts"
          hidden={!isStoreTabActive('scripts')}
          className="rb-panel"
        >
          <ScriptEditor />
        </div>

        <div
          id="rb-panel-tests"
          role="tabpanel"
          aria-label="Assertion tests"
          hidden={!isStoreTabActive('tests')}
          className="rb-panel rb-panel--tests"
        >
          <AssertionsPanel />
        </div>

        <div
          id="rb-panel-auth"
          role="tabpanel"
          aria-label="Authentication"
          hidden={!isStoreTabActive('auth')}
          className="rb-panel"
        >
          <AuthPanel />
        </div>

        {savePath !== null && (
          <div
            id="rb-panel-history"
            role="tabpanel"
            aria-label="Request execution history"
            hidden={!isHistoryTabActive}
            className="rb-panel rb-panel--history"
          >
            <HistoryPanel requestPath={savePath} />
          </div>
        )}
      </div>

      {/* Code generation modal */}
      {codegenOpen && (
        <CodegenPanel onClose={() => setCodegenOpen(false)} />
      )}
    </div>
  );
});
