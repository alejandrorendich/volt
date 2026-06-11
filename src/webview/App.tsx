/**
 * @fileoverview Volt App — root layout shell.
 *
 * Renders the two-panel split layout (RequestBuilder left, ResponseViewer
 * right) and wires the global message handler that routes WebviewMessages
 * to the appropriate Zustand stores.
 *
 * Layout adapts to narrow panels: below 600px it stacks vertically.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RequestBuilder } from './components/RequestBuilder';
import { ResponseViewer } from './components/ResponseViewer';
import { EnvSwitcher } from './components/EnvSwitcher';
import { TabBar } from './components/TabBar';
import { CollectionRunner } from './components/CollectionRunner';
import { useMessage, postMessageToHost } from './hooks/useMessage';
import { useSaveRequest } from './hooks/useSaveRequest';
import { useRequestStore } from './stores/request-store';
import { useResponseStore } from './stores/response-store';
import { useCollectionStore } from './stores/collection-store';
import { useEnvStore } from './stores/env-store';
import { useHistoryStore } from './stores/history-store';
import { useRunnerStore } from './stores/runner-store';
import type { WebviewMessage } from '../shared/protocol';
import './styles/app.css';

// Store references used inside the stable handleMessage callback via getState()
// (avoids stale closure — H-01)

// ---------------------------------------------------------------------------
// Message handler — routes host messages to stores
// ---------------------------------------------------------------------------

function useMessageRouter(): void {
  const handleMessage = useCallback(
    (msg: WebviewMessage) => {
      const responseStore = useResponseStore.getState();
      const collectionStore = useCollectionStore.getState();
      const envStore = useEnvStore.getState();
      const requestStore = useRequestStore.getState();
      const historyStore = useHistoryStore.getState();
      const runnerStore = useRunnerStore.getState();

      switch (msg.type) {
        case 'response:execute-http':
          responseStore.setResponse(msg.payload);
          requestStore.setLoading(false, null);
          // Refresh history if this is a saved request
          {
            const sp = requestStore.savePath;
            if (sp) {
              postMessageToHost({
                type: 'request:get-history',
                correlationId: `refresh-history-${Date.now()}`,
                payload: { path: sp },
              });
            }
          }
          break;

        case 'response:execute-error':
          responseStore.setError({
            message: msg.payload.message,
            ...(msg.payload.code !== undefined ? { code: msg.payload.code } : {}),
          });
          // Only clear the loading state if this error corresponds to the
          // active in-flight request — other error messages (e.g. env/collection
          // errors) share the same message type but should not stop the spinner.
          if (msg.correlationId === requestStore.activeCorrelationId) {
            requestStore.setLoading(false, null);
          }
          break;

        case 'response:collection':
          collectionStore.setTree(msg.payload);
          break;

        case 'event:environment-changed':
          envStore.setEnv(msg.payload);
          break;

        case 'event:load-request':
          // Tree item selected — load request definition into the builder
          {
            const loadedHeaders = Object.entries(msg.payload.headers).map(([key, value], i) => ({
              id: `h-${i}`,
              key,
              value,
              enabled: true,
            }));
            // Always include a trailing empty row for adding new headers
            loadedHeaders.push({ id: `h-${loadedHeaders.length}`, key: '', value: '', enabled: true });

            const loadedParams = (msg.payload.queryParams as Array<{ key: string; value: string; enabled: boolean }>).slice();
            // Always include a trailing empty row for adding new params
            loadedParams.push({ key: '', value: '', enabled: true });

            requestStore.loadRequest({
              id: msg.payload.id,
              name: msg.payload.name ?? '',
              savePath: msg.payload.id,
              method: msg.payload.method,
              url: msg.payload.url,
              headers: loadedHeaders,
              body: msg.payload.body ?? { type: 'none' },
              queryParams: loadedParams,
              preScript: msg.payload.preScript ?? '',
              postScript: msg.payload.postScript ?? '',
              sslVerify: msg.payload.settings?.sslVerify !== false,
              assertions: msg.payload.assertions ? [...msg.payload.assertions] : [],
            });
            // Reset response panel for fresh context
            responseStore.reset();
            // Focus URL input after loading
            setTimeout(() => {
              const urlInput = document.querySelector<HTMLInputElement>('.rb-url-input');
              urlInput?.focus();
            }, 50);
          }
          break;

        case 'event:request-progress':
          // Progress events during live requests — show streaming phase indicator
          requestStore.setStreamingPhase(msg.payload.phase);
          break;

        case 'event:script-error':
          // Script execution failed — surface visually in the Scripts tab
          requestStore.setScriptError(msg.payload);
          break;

        case 'event:assertion-results':
          // Assertion results — store for display in the Tests tab
          requestStore.setAssertionResults([...msg.payload.results]);
          break;

        case 'response:request-saved':
          // Host confirms save — update savePath so future saves hit the same file
          requestStore.setSavePath(msg.payload.path);
          requestStore.markSaved();
          break;

        case 'response:history':
          // Host replies with history entries for the requested path
          historyStore.setHistory(msg.payload.path, msg.payload.entries);
          break;

        case 'event:runner-progress':
          // Per-request progress from the collection runner
          {
            const p = msg.payload;
            // Initialize run if not yet started
            if (runnerStore.status === 'idle') {
              runnerStore.startRun('', p.total);
            }
            // Only add non-empty progress (skip the initializer sentinel with empty requestName)
            if (p.requestName) {
              runnerStore.addProgress({
                index: p.index,
                total: p.total,
                requestName: p.requestName,
                status: p.status,
                time: p.time,
                pass: p.pass,
                assertionsPassed: p.assertionsPassed,
                assertionsTotal: p.assertionsTotal,
              });
            }
          }
          break;

        case 'event:runner-complete':
          // Run finished
          runnerStore.complete({
            total: msg.payload.total,
            passed: msg.payload.passed,
            failed: msg.payload.failed,
            totalTime: msg.payload.totalTime,
          });
          break;

        default:
          break;
      }
    },
    [],
  );

  useMessage(handleMessage);
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const { send } = useMessage();

  // Send webview-ready handshake on mount
  useEffect(() => {
    send({
      type: 'request:ready',
      correlationId: `ready-${Date.now()}`,
    });
  }, [send]);

  // Route host messages to stores
  useMessageRouter();

  // Autosave + Ctrl+S
  useSaveRequest();

  // Track runner status to know whether to show the runner panel
  const runnerStatus = useRunnerStore((s) => s.status);

  // Resizable split panel
  const splitRef = useRef<HTMLDivElement>(null);
  const [builderWidth, setBuilderWidth] = useState<number | null>(null);
  const dragging = useRef(false);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(Math.max(pct, 20), 80);
      setBuilderWidth(clamped);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return (
    <div className="volt-app">
      {/* Header: environment switcher */}
      <div className="volt-header">
        <span className="volt-header__brand" aria-label="Volt HTTP Client">⚡ Volt</span>
        <EnvSwitcher />
      </div>
      <div className="volt-split" ref={splitRef}>
        <div className="volt-panel volt-panel--builder" style={builderWidth !== null ? { flex: `0 0 ${builderWidth}%` } : undefined}>
          <TabBar />
          <RequestBuilder />
        </div>
        <div
          className="volt-split__divider"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleDividerMouseDown}
        />
        <div className="volt-panel volt-panel--response" style={builderWidth !== null ? { flex: `0 0 ${100 - builderWidth}%` } : undefined}>
          {runnerStatus !== 'idle' ? <CollectionRunner /> : <ResponseViewer />}
        </div>
      </div>
    </div>
  );
}
