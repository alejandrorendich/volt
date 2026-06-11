/**
 * @fileoverview Volt webview entry point.
 *
 * Mounts the React 18 root and sends the webview-ready handshake to the
 * extension host so queued messages are flushed.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('[Volt] Root element #root not found in webview HTML');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
