/**
 * @fileoverview Collection store — synced collection tree from host.
 *
 * Updated when a `collection-loaded` WebviewMessage arrives.
 * The tree is read-only in the webview; mutations go through host messages.
 */

import { create } from 'zustand';
import type { CollectionTree } from '../../../shared/models';

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface CollectionState {
  tree: CollectionTree | null;
  loading: boolean;
  error: string | null;
}

export interface CollectionActions {
  setTree: (tree: CollectionTree) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export type CollectionStore = CollectionState & CollectionActions;

export const useCollectionStore = create<CollectionStore>((set) => ({
  tree: null,
  loading: false,
  error: null,

  setTree: (tree) => set({ tree, loading: false, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
}));
