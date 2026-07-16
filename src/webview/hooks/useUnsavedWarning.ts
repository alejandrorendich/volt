/**
 * @fileoverview useUnsavedWarning — notify the host about webview dirty state.
 *
 * Since autosave was removed, every change must be saved explicitly by the
 * user. To avoid silent data loss, this hook:
 *
 * 1. Pushes the active tab's `dirty` flag to the host via `webview:set-dirty`
 *    so the panel title can show a modified marker (`● Volt`).
 * 2. Registers a `beforeunload` handler as a best-effort guard — VS Code
 *    does not let the extension host intercept a regular `WebviewPanel`
 *    close (`onDidDispose` fires after the webview is torn down), but
 *    `beforeunload` is honored for webview reloads and some close paths.
 *    The host shows a post-hoc `showWarningMessage` notification if the
 *    panel is disposed while still dirty.
 */

import { useEffect, useRef } from 'react';
import { useRequestStore } from '../stores/request-store';
import { useMessage } from './useMessage';

export function useUnsavedWarning(): void {
  const { send } = useMessage();
  const lastSentRef = useRef<boolean | null>(null);

  // Push dirty state to host whenever it changes.
  useEffect(() => {
    const unsub = useRequestStore.subscribe((state) => {
      const currentTab = state.tabs.find((t) => t.tabId === state.activeTabId);
      const dirty = currentTab?.dirty ?? false;

      if (lastSentRef.current === dirty) return;
      lastSentRef.current = dirty;

      send({
        type: 'webview:set-dirty',
        correlationId: `dirty-${Date.now()}`,
        payload: { dirty },
      });
    });

    return () => {
      unsub();
      lastSentRef.current = null;
    };
  }, [send]);

  // Best-effort native prompt if the webview is unloaded while dirty.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      const s = useRequestStore.getState();
      const currentTab = s.tabs.find((t) => t.tabId === s.activeTabId);
      if (!currentTab?.dirty) return;

      // Setting returnValue triggers the browser-style confirmation. VS Code
      // honors this for webview reloads; it is a no-op for the standard panel
      // close button — that case is covered by the host's onDidDispose.
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
}
