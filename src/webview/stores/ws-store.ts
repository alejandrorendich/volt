/**
 * @fileoverview WebSocket store — connection state and message log.
 *
 * Holds the live WebSocket session: connection status, the FIFO message log
 * (capped at MAX_MESSAGES), and the current connection URL.
 */

import { create } from 'zustand';
import type { WsMessage } from '../../shared/models';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of messages kept in memory (FIFO). */
const MAX_MESSAGES = 500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type WsConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WsState {
  /** Current connection lifecycle state. */
  status: WsConnectionStatus;
  /** URL of the active or last connection. */
  connectedUrl: string;
  /** Capped FIFO message log. */
  messages: WsMessage[];
  /** Last error message, if any. */
  errorMessage: string | null;
  /** Close code of the last disconnection, if any. */
  closeCode: number | null;
  /** Close reason of the last disconnection, if any. */
  closeReason: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface WsActions {
  setConnecting: (url: string) => void;
  setConnected: (url: string) => void;
  addMessage: (msg: WsMessage) => void;
  setDisconnected: (code: number, reason: string) => void;
  setError: (message: string) => void;
  clearMessages: () => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type WsStore = WsState & WsActions;

const initialState: WsState = {
  status: 'idle',
  connectedUrl: '',
  messages: [],
  errorMessage: null,
  closeCode: null,
  closeReason: null,
};

export const useWsStore = create<WsStore>((set) => ({
  ...initialState,

  setConnecting: (url) =>
    set({ status: 'connecting', connectedUrl: url, errorMessage: null, closeCode: null, closeReason: null }),

  setConnected: (url) =>
    set({ status: 'connected', connectedUrl: url, errorMessage: null }),

  addMessage: (msg) =>
    set((state) => {
      const next = [...state.messages, msg];
      // FIFO: drop oldest messages if over limit
      return { messages: next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next };
    }),

  setDisconnected: (code, reason) =>
    set({ status: 'disconnected', closeCode: code, closeReason: reason }),

  setError: (message) =>
    set({ status: 'error', errorMessage: message }),

  clearMessages: () => set({ messages: [] }),

  reset: () => set(initialState),
}));
