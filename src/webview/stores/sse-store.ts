/**
 * @fileoverview SSE store — streaming event log for text/event-stream responses.
 *
 * Holds the list of received SSE events. Capped at MAX_EVENTS in memory (FIFO).
 */

import { create } from 'zustand';
import type { SseEvent } from '../../shared/models';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS = 500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SseStatus = 'idle' | 'streaming' | 'ended';

export interface SseState {
  status: SseStatus;
  events: SseEvent[];
  endReason: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface SseActions {
  startStreaming: () => void;
  addEvent: (event: SseEvent) => void;
  setEnded: (reason: string) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type SseStore = SseState & SseActions;

const initialState: SseState = {
  status: 'idle',
  events: [],
  endReason: null,
};

export const useSseStore = create<SseStore>((set) => ({
  ...initialState,

  startStreaming: () => set({ status: 'streaming', events: [], endReason: null }),

  addEvent: (event) =>
    set((state) => {
      const next = [...state.events, event];
      return { events: next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next };
    }),

  setEnded: (reason) => set({ status: 'ended', endReason: reason }),

  reset: () => set(initialState),
}));
