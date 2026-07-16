/**
 * @fileoverview useSaveRequest — handles manual save (Ctrl+S).
 *
 * Manual save is immediate via Ctrl+S or the Save button.
 * Both send `request:save-request` to the host.
 *
 * Autosave is intentionally disabled: changes are only persisted when the user
 * explicitly saves. Use `useUnsavedWarning` to surface the dirty state.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useRequestStore } from '../stores/request-store';
import { useMessage } from './useMessage';

export function useSaveRequest(): { saveNow: () => void } {
  const { send } = useMessage();
  const lastSavedRef = useRef<string>('');

  const save = useCallback(() => {
    const s = useRequestStore.getState();
    if (!s.savePath) return; // Can't save without a file path

    const def = s.toRequestDef();
    const serialized = JSON.stringify(def);

    // Skip if nothing changed since last save
    if (serialized === lastSavedRef.current) return;
    lastSavedRef.current = serialized;

    send({
      type: 'request:save-request',
      correlationId: `save-${Date.now()}`,
      payload: { path: s.savePath, request: def },
    });

    s.markSaved();
  }, [send]);

  // Ctrl+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [save]);

  return { saveNow: save };
}
