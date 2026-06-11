/**
 * @fileoverview History store — per-request execution history.
 *
 * Stores the history entries received from the host via `response:history`.
 * Keyed by request path so multiple tabs can have independent history views.
 */

import { create } from 'zustand';
import type { HistoryEntry } from '../../shared/protocol';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HistoryState {
  /** Map from request path → history entries (newest first) */
  readonly histories: ReadonlyMap<string, readonly HistoryEntry[]>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface HistoryActions {
  /** Set (replace) history entries for the given request path. */
  setHistory: (path: string, entries: readonly HistoryEntry[]) => void;
  /** Remove history entries for a given path (after clear). */
  clearHistory: (path: string) => void;
  /** Get entries for a given path, or empty array if not loaded yet. */
  getHistory: (path: string) => readonly HistoryEntry[];
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type HistoryStore = HistoryState & HistoryActions;

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  histories: new Map(),

  setHistory: (path, entries) => {
    const updated = new Map(get().histories);
    updated.set(path, entries);
    set({ histories: updated });
  },

  clearHistory: (path) => {
    const updated = new Map(get().histories);
    updated.delete(path);
    set({ histories: updated });
  },

  getHistory: (path) => {
    return get().histories.get(path) ?? [];
  },
}));
