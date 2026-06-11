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

import React, { useCallback, useId, useRef, memo } from 'react';
import { useRequestStore } from '../stores/request-store';
import { useResponseStore } from '../stores/response-store';
import { useMessage } from '../hooks/useMessage';
import { KeyValueEditor } from './KeyValueEditor';
import type { HttpMethod, RequestBody } from '../../shared/models';
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

const BODY_TYPES: Array<RequestBody['type']> = ['none', 'json', 'text', 'form-data'];

const BODY_TYPE_LABELS: Record<RequestBody['type'], string> = {
  none: 'None',
  json: 'JSON',
  text: 'Text',
  'form-data': 'Form Data',
};

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
// Body editor
// ---------------------------------------------------------------------------

interface BodyEditorProps {
  method: HttpMethod;
}

const BodyEditor = memo(function BodyEditor({ method }: BodyEditorProps): React.ReactElement {
  const body = useRequestStore((s) => s.body);
  const setBody = useRequestStore((s) => s.setBody);
  const addHeader = useRequestStore((s) => s.addHeader);
  const updateHeader = useRequestStore((s) => s.updateHeader);
  const removeHeader = useRequestStore((s) => s.removeHeader);

  // Form-data rows reuse the headers store type
  const formRows = useRequestStore((s) => s.headers);

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
      } else {
        setBody({ type: t, content: (body as { content?: string }).content ?? '' });
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
            onClick={() => setBody(t === 'none' ? { type: 'none' } : { type: t as 'json' | 'text' | 'form-data', content: '' })}
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
          rows={formRows}
          onAdd={addHeader}
          onUpdate={updateHeader}
          onRemove={removeHeader}
          keyPlaceholder="Field name"
          valuePlaceholder="Value"
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// RequestBuilder
// ---------------------------------------------------------------------------

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

  const setResponse = useResponseStore((s) => s.setLoading);

  const { send } = useMessage();

  const correlationIdRef = useRef<string>('');

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
    if (loading) {
      // Cancel
      if (activeCorrelationId) {
        send({
          type: 'cancel-request',
          correlationId: `cancel-${Date.now()}`,
          payload: { id: activeCorrelationId },
        });
      }
      setLoading(false, null);
      return;
    }

    const requestDef = toRequestDef();
    const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    correlationIdRef.current = correlationId;

    setLoading(true, correlationId);
    setResponse();

    send({
      type: 'execute-request',
      correlationId,
      payload: requestDef,
    });
  }, [loading, activeCorrelationId, send, setLoading, toRequestDef, setResponse]);

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

        {/* Send / Cancel */}
        <button
          type="button"
          className={`rb-send${loading ? ' rb-send--cancel' : ''}`}
          onClick={handleSend}
          disabled={!loading && url.trim() === ''}
          aria-label={loading ? 'Cancel request' : 'Send request'}
          title={loading ? 'Cancel (Esc)' : 'Send (Enter)'}
        >
          {loading ? (
            <>
              <span className="rb-send__spinner" aria-hidden="true" />
              Cancel
            </>
          ) : (
            'Send'
          )}
        </button>
      </div>

      {/* ---- Tabs row ---- */}
      <div className="rb-tabs" role="tablist" aria-label="Request options">
        <button
          role="tab"
          type="button"
          className={`rb-tab${activeTab === 'params' ? ' rb-tab--active' : ''}`}
          onClick={() => setActiveTab('params')}
          aria-selected={activeTab === 'params'}
          aria-controls="rb-panel-params"
        >
          Params {enabledParamCount > 0 && <span className="rb-badge">{enabledParamCount}</span>}
        </button>
        <button
          role="tab"
          type="button"
          className={`rb-tab${activeTab === 'headers' ? ' rb-tab--active' : ''}`}
          onClick={() => setActiveTab('headers')}
          aria-selected={activeTab === 'headers'}
          aria-controls="rb-panel-headers"
        >
          Headers {enabledHeaderCount > 0 && <span className="rb-badge">{enabledHeaderCount}</span>}
        </button>
        <button
          role="tab"
          type="button"
          className={`rb-tab${activeTab === 'body' ? ' rb-tab--active' : ''}`}
          onClick={() => setActiveTab('body')}
          aria-selected={activeTab === 'body'}
          aria-controls="rb-panel-body"
        >
          Body
        </button>
      </div>

      {/* ---- Panel content ---- */}
      <div className="rb-panel-area">
        <div
          id="rb-panel-params"
          role="tabpanel"
          aria-label="Query parameters"
          hidden={activeTab !== 'params'}
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
          hidden={activeTab !== 'headers'}
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
          hidden={activeTab !== 'body'}
          className="rb-panel"
        >
          <BodyEditor method={method} />
        </div>
      </div>
    </div>
  );
});
