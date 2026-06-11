/**
 * @fileoverview Volt App — root layout shell.
 *
 * Renders the two-panel split layout (RequestBuilder left, ResponseViewer
 * right) and wires the global message handler that routes WebviewMessages
 * to the appropriate Zustand stores.
 *
 * Layout adapts to narrow panels: below 600px it stacks vertically.
 */

import React, { useCallback, useEffect } from 'react';
import { RequestBuilder } from './components/RequestBuilder';
import { ResponseViewer } from './components/ResponseViewer';
import { useMessage } from './hooks/useMessage';
import { useRequestStore } from './stores/request-store';
import { useResponseStore } from './stores/response-store';
import { useCollectionStore } from './stores/collection-store';
import { useEnvStore } from './stores/env-store';
import type { WebviewMessage } from '../shared/protocol';
import './styles/app.css';

// ---------------------------------------------------------------------------
// Message handler — routes host messages to stores
// ---------------------------------------------------------------------------

function useMessageRouter(): void {
  const responseStore = useResponseStore();
  const collectionStore = useCollectionStore();
  const envStore = useEnvStore();
  const requestStore = useRequestStore();

  const handleMessage = useCallback(
    (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'execute-response':
          responseStore.setResponse(msg.payload);
          requestStore.setLoading(false, null);
          break;

        case 'execute-error':
          responseStore.setError({ message: msg.payload.message, code: msg.payload.code });
          requestStore.setLoading(false, null);
          break;

        case 'collection-loaded':
          collectionStore.setTree(msg.payload);
          break;

        case 'environment-changed':
          envStore.setEnv(msg.payload);
          break;

        case 'request-progress':
          // Progress events during live requests — kept for future live indicator
          break;

        default:
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      type: 'webview-ready',
      correlationId: `ready-${Date.now()}`,
    });
  }, [send]);

  // Route host messages to stores
  useMessageRouter();

  return (
    <div className="volt-app">
      <div className="volt-split">
        <div className="volt-panel volt-panel--builder">
          <RequestBuilder />
        </div>
        <div className="volt-split__divider" role="separator" aria-orientation="vertical" />
        <div className="volt-panel volt-panel--response">
          <ResponseViewer />
        </div>
      </div>
    </div>
  );
}
