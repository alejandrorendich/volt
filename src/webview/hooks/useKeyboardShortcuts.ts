/**
 * @fileoverview useKeyboardShortcuts — global keyboard shortcut handler for Volt.
 *
 * Registers document-level keydown listeners for shortcuts that must work
 * regardless of which element is focused in the webview.
 *
 * Shortcuts handled:
 * - Ctrl+Enter   — send the current request (or connect/disconnect WS)
 * - Ctrl+L       — focus the URL input
 * - Ctrl+D       — duplicate the current request (save with "-copy" suffix)
 *
 * Ctrl+S is handled separately by `useSaveRequest`.
 * Ctrl+N is intentionally omitted — new-request creation lives on the host side.
 *
 * All handlers are no-ops when a textarea or non-URL input is focused
 * EXCEPT Ctrl+L (which is always active) and Ctrl+Enter (which fires globally).
 */

import { useEffect, useCallback } from 'react';
import { useMessage } from './useMessage';
import { useRequestStore } from '../stores/request-store';

export function useKeyboardShortcuts(onSend: () => void): void {
  const { send } = useMessage();

  const handleSend = useCallback(() => onSend(), [onSend]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      // ------------------------------------------------------------------
      // Ctrl+Enter — send / connect / cancel
      // ------------------------------------------------------------------
      if (e.key === 'Enter') {
        // Skip if inside a textarea that isn't the URL area
        const target = e.target as HTMLElement;
        const isTextarea = target.tagName === 'TEXTAREA';
        const isNonUrlInput =
          target.tagName === 'INPUT' &&
          !target.classList.contains('rb-url-input');

        if (isTextarea || isNonUrlInput) return;

        e.preventDefault();
        const url = useRequestStore.getState().url.trim();
        if (url !== '') {
          handleSend();
        }
        return;
      }

      // ------------------------------------------------------------------
      // Ctrl+L — focus URL input
      // ------------------------------------------------------------------
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        const urlInput = document.querySelector<HTMLInputElement>('.rb-url-input');
        if (urlInput) {
          urlInput.focus();
          urlInput.select();
        }
        return;
      }

      // ------------------------------------------------------------------
      // Ctrl+D — duplicate current request
      // ------------------------------------------------------------------
      if (e.key === 'd' || e.key === 'D') {
        // Don't steal Ctrl+D from inputs/textareas
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

        e.preventDefault();
        const s = useRequestStore.getState();
        if (!s.savePath) return; // Nothing to duplicate — not a saved request

        const copyPath = `${s.savePath}-copy`;
        const def = s.toRequestDef();

        send({
          type: 'request:save-request',
          correlationId: `dup-${Date.now()}`,
          payload: {
            path: copyPath,
            request: {
              ...def,
              id: copyPath,
              name: def.name ? `${def.name} (copy)` : `${s.savePath} (copy)`,
            },
          },
        });
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSend, send]);
}
