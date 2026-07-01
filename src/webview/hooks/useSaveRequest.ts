/**
 * @fileoverview useSaveRequest — handles manual save (Ctrl+S) and autosave.
 *
 * Autosave triggers 1.5s after the last change (debounced).
 * Manual save is immediate via Ctrl+S or Save button.
 * Both send `request:save-request` to the host.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useRequestStore } from '../stores/request-store';
import { useMessage } from './useMessage';

const AUTOSAVE_DELAY_MS = 1500;

export function useSaveRequest(): { saveNow: () => void } {
  const { send } = useMessage();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Autosave: watch for dirty state changes
  useEffect(() => {
    const unsub = useRequestStore.subscribe((state, prev) => {
      // Only autosave if we have a savePath and the tab is dirty
      const currentTab = state.tabs.find((t) => t.tabId === state.activeTabId);
      if (!currentTab?.dirty || !state.savePath) return;

      // Check if request-relevant state actually changed
      if (
        state.method === prev.method &&
        state.url === prev.url &&
        state.headers === prev.headers &&
        state.body === prev.body &&
        state.queryParams === prev.queryParams &&
        state.preScript === prev.preScript &&
        state.postScript === prev.postScript &&
        state.notes === prev.notes &&
        state.notesUpdatedAt === prev.notesUpdatedAt
      ) {
        return;
      }

      // Debounce
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(save, AUTOSAVE_DELAY_MS);
    });

    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [save]);

  // Ctrl+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
