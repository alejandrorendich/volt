/**
 * @fileoverview ResponseViewer — HTTP response display component.
 *
 * Shows status badge, response metadata (time + size), tabbed content
 * (Body / Headers / Timing), and handles empty/loading/error states.
 *
 * @see REQ-RV-001 through REQ-RV-006
 */

import React, { memo, useCallback, useMemo, useState } from 'react';
import { useResponseStore } from '../stores/response-store';
import { useRequestStore } from '../stores/request-store';
import { useMessage } from '../hooks/useMessage';
import { TimingBar } from './TimingBar';
import { buildCurlCommand } from '../utils/curl';
import type { HttpResponseDef } from '../../shared/models';
import './ResponseViewer.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map status code to semantic class suffix (2xx → success, etc.) */
function statusClass(status: number): string {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'client-error';
  if (status >= 500) return 'server-error';
  return 'unknown';
}

/** Format byte count to human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Format milliseconds to human-readable string. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// ---------------------------------------------------------------------------
// Body display — JSON pretty-print + syntax highlighting
// ---------------------------------------------------------------------------

const MAX_DISPLAY_BYTES = 1_000_000; // 1 MB display limit

/** Very lightweight JSON syntax highlighter using regex replacement. */
function highlightJson(json: string): string {
  return json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'rv-json-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'rv-json-key' : 'rv-json-string';
        } else if (/true|false/.test(match)) {
          cls = 'rv-json-bool';
        } else if (/null/.test(match)) {
          cls = 'rv-json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      },
    );
}

interface BodyDisplayProps {
  response: HttpResponseDef;
}

const BodyDisplay = memo(function BodyDisplay({ response }: BodyDisplayProps): React.ReactElement {
  const { body, bodySize, headers, truncated, bodyRef } = response;
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';

  const isJson = contentType.includes('json');
  const isHtml = contentType.includes('html');
  const isXml = contentType.includes('xml');
  const isBinary = contentType.includes('octet-stream') || contentType.includes('image/');

  const tooLarge = body.length > MAX_DISPLAY_BYTES;
  const displayBody = tooLarge ? body.slice(0, MAX_DISPLAY_BYTES) : body;

  const { send } = useMessage();

  const copyBody = useCallback(() => {
    void navigator.clipboard.writeText(body);
  }, [body]);

  const saveToFile = useCallback(() => {
    send({
      type: 'request:save-to-file',
      correlationId: `save-${Date.now()}`,
      payload: {
        suggestedName: 'response.txt',
        content: body,
      },
    });
  }, [body, send]);

  // REQ-MSG-005: Large body reference — body was offloaded to a temp file
  if (bodyRef) {
    const sizeMB = (bodySize / (1024 * 1024)).toFixed(1);
    return (
      <div className="rv-body-ref">
        <span className="rv-body-ref__icon" aria-hidden="true">📦</span>
        <span>Response too large to display ({sizeMB} MB).</span>
        <button
          type="button"
          className="rv-body-ref__save"
          aria-label="Save large response body"
          onClick={() =>
            send({
              type: 'request:save-to-file',
              correlationId: `save-${Date.now()}`,
              payload: { suggestedName: 'response.txt', content: bodyRef },
            })
          }
        >
          Click to save
        </button>
      </div>
    );
  }

  // JSON pretty-print attempt
  const prettyJson = useMemo(() => {
    if (!isJson) return null;
    try {
      return JSON.stringify(JSON.parse(displayBody), null, 2);
    } catch {
      return displayBody;
    }
  }, [isJson, displayBody]);

  if (body === '' && !isBinary) {
    const statusCode = response.status;
    const isNoContent = statusCode === 204 || statusCode === 304;
    return (
      <div className="rv-body-empty">
        <span className="rv-empty-hint">
          {isNoContent ? `No content (${statusCode})` : 'Empty response body'}
        </span>
      </div>
    );
  }

  if (isBinary) {
    return (
      <div className="rv-body-binary">
        <span className="rv-body-binary__icon" aria-hidden="true">⬡</span>
        <span>Binary response — {formatBytes(bodySize)}</span>
        <button type="button" className="rv-action-btn" onClick={saveToFile}>
          Save to file
        </button>
      </div>
    );
  }

  return (
    <div className="rv-body-raw">
      {tooLarge && (
        <div className="rv-body-warning" role="alert">
          <span>Response too large — showing first {formatBytes(MAX_DISPLAY_BYTES)} of {formatBytes(bodySize)}</span>
          <button type="button" className="rv-action-btn" onClick={saveToFile}>
            Save full response
          </button>
        </div>
      )}
      {truncated && !tooLarge && (
        <div className="rv-body-warning" role="alert">
          Response truncated at host (50 MB limit) — actual size: {formatBytes(bodySize)}
        </div>
      )}
      {isJson && prettyJson !== null ? (
        <pre
          className="rv-body-pre rv-json"
          // eslint-disable-next-line react/no-danger -- intentional syntax highlight
          dangerouslySetInnerHTML={{ __html: highlightJson(prettyJson) }}
          aria-label="Response body (JSON)"
        />
      ) : (
        <pre
          className={`rv-body-pre${isHtml || isXml ? ' rv-body-pre--markup' : ''}`}
          aria-label="Response body"
        >
          {displayBody}
        </pre>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Headers table
// ---------------------------------------------------------------------------

interface HeadersTableProps {
  headers: Record<string, string>;
}

const HeadersTable = memo(function HeadersTable({ headers }: HeadersTableProps): React.ReactElement {
  const sorted = useMemo(
    () =>
      Object.entries(headers).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase())),
    [headers],
  );

  if (sorted.length === 0) {
    return <div className="rv-empty-hint">No response headers</div>;
  }

  return (
    <table className="rv-headers-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(([key, value]) => (
          <tr key={key}>
            <td className="rv-header-key">{key}</td>
            <td className="rv-header-value">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

interface StatusBarProps {
  response: HttpResponseDef;
}

const StatusBar = memo(function StatusBar({ response }: StatusBarProps): React.ReactElement {
  const cls = statusClass(response.status);
  const [copyBodyFeedback, setCopyBodyFeedback] = useState(false);
  const [copyCurlFeedback, setCopyCurlFeedback] = useState(false);

  // Pull the current request from the store to build a proper cURL command
  const toRequestDef = useRequestStore((s) => s.toRequestDef);

  const copyBody = useCallback(() => {
    void navigator.clipboard.writeText(response.body).then(() => {
      setCopyBodyFeedback(true);
      setTimeout(() => setCopyBodyFeedback(false), 1500);
    });
  }, [response.body]);

  const copyAsCurl = useCallback(() => {
    const request = toRequestDef();
    const curl = buildCurlCommand(request);
    void navigator.clipboard.writeText(curl).then(() => {
      setCopyCurlFeedback(true);
      setTimeout(() => setCopyCurlFeedback(false), 1500);
    });
  }, [toRequestDef]);

  return (
    <div className="rv-status-bar">
      <span className={`rv-status-badge rv-status-badge--${cls}`} aria-label={`HTTP ${response.status}`}>
        {response.status} {response.statusText}
      </span>
      <span className="rv-meta-item" title="Response time">
        {formatMs(response.timing.total)}
      </span>
      <span className="rv-meta-separator" aria-hidden="true">·</span>
      <span className="rv-meta-item" title="Response size">
        {formatBytes(response.bodySize)}
      </span>
      <div className="rv-actions">
        <button
          type="button"
          className={`rv-action-btn${copyBodyFeedback ? ' rv-action-btn--success' : ''}`}
          onClick={copyBody}
          title="Copy response body (raw)"
          aria-label="Copy response body"
        >
          {copyBodyFeedback ? '✓ Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className={`rv-action-btn${copyCurlFeedback ? ' rv-action-btn--success' : ''}`}
          onClick={copyAsCurl}
          title="Copy as cURL command"
          aria-label="Copy as cURL"
        >
          {copyCurlFeedback ? '✓ Copied' : 'cURL'}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// ResponseViewer
// ---------------------------------------------------------------------------

export const ResponseViewer = memo(function ResponseViewer(): React.ReactElement {
  const status = useResponseStore((s) => s.status);
  const response = useResponseStore((s) => s.response);
  const error = useResponseStore((s) => s.error);
  const activeTab = useResponseStore((s) => s.activeTab);
  const setActiveTab = useResponseStore((s) => s.setActiveTab);

  const headerCount = response ? Object.keys(response.headers).length : 0;

  // ---- States ----
  if (status === 'idle') {
    return (
      <div className="rv-root rv-root--empty">
        <div className="rv-empty-state">
          <span className="rv-empty-state__icon" aria-hidden="true">⇄</span>
          <span>Send a request to see the response</span>
        </div>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="rv-root rv-root--loading">
        <div className="rv-loading-state">
          <span className="rv-loading-state__spinner" aria-hidden="true" />
          <span>Waiting for response…</span>
        </div>
      </div>
    );
  }

  if (status === 'error' && error) {
    const errorLabel: Record<string, string> = {
      timeout: 'Request timed out — the server did not respond in time.',
      cancelled: 'Request was cancelled.',
      dns_error: 'DNS resolution failed — check the hostname.',
      connection_refused: 'Connection refused — is the server running?',
      tls_error: 'TLS/SSL error — check the certificate.',
      too_large: 'Response too large to process.',
      unknown: 'An unknown network error occurred.',
    };

    return (
      <div className="rv-root rv-root--error">
        <div className="rv-error-state">
          <span className="rv-error-state__icon" aria-hidden="true">✗</span>
          <div className="rv-error-state__content">
            <strong>{error.code ? (error.code.replace(/_/g, ' ')) : 'Error'}</strong>
            <span>{error.code ? errorLabel[error.code] ?? error.message : error.message}</span>
          </div>
        </div>
      </div>
    );
  }

  if (!response) return <></>;

  return (
    <div className="rv-root">
      {/* Status bar */}
      <StatusBar response={response} />

      {/* Tabs */}
      <div className="rv-tabs" role="tablist" aria-label="Response content">
        <button
          role="tab"
          type="button"
          className={`rv-tab${activeTab === 'body' ? ' rv-tab--active' : ''}`}
          onClick={() => setActiveTab('body')}
          aria-selected={activeTab === 'body'}
          aria-controls="rv-panel-body"
        >
          Body
        </button>
        <button
          role="tab"
          type="button"
          className={`rv-tab${activeTab === 'headers' ? ' rv-tab--active' : ''}`}
          onClick={() => setActiveTab('headers')}
          aria-selected={activeTab === 'headers'}
          aria-controls="rv-panel-headers"
        >
          Headers
          {headerCount > 0 && <span className="rv-badge">{headerCount}</span>}
        </button>
        <button
          role="tab"
          type="button"
          className={`rv-tab${activeTab === 'timing' ? ' rv-tab--active' : ''}`}
          onClick={() => setActiveTab('timing')}
          aria-selected={activeTab === 'timing'}
          aria-controls="rv-panel-timing"
        >
          Timing
        </button>
      </div>

      {/* Panel content */}
      <div className="rv-panel-area">
        <div
          id="rv-panel-body"
          role="tabpanel"
          aria-label="Response body"
          hidden={activeTab !== 'body'}
          className="rv-panel"
        >
          <BodyDisplay response={response} />
        </div>

        <div
          id="rv-panel-headers"
          role="tabpanel"
          aria-label="Response headers"
          hidden={activeTab !== 'headers'}
          className="rv-panel"
        >
          <HeadersTable headers={response.headers} />
        </div>

        <div
          id="rv-panel-timing"
          role="tabpanel"
          aria-label="Timing breakdown"
          hidden={activeTab !== 'timing'}
          className="rv-panel"
        >
          <TimingBar timing={response.timing} />
        </div>
      </div>
    </div>
  );
});
