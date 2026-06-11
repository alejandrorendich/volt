/**
 * @fileoverview Response store — last HTTP response received from the host.
 *
 * Updated by the message handler when an `execute-response` or
 * `execute-error` WebviewMessage arrives.
 */

import { create } from 'zustand';
import type { HttpResponseDef } from '../../shared/models';
import type { ExecuteErrorCode } from '../../shared/protocol';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ResponseStatus = 'idle' | 'loading' | 'success' | 'error';

export interface ResponseError {
  readonly message: string;
  readonly code?: ExecuteErrorCode;
}

export interface ResponseState {
  status: ResponseStatus;
  response: HttpResponseDef | null;
  error: ResponseError | null;
  /** Active content tab. */
  activeTab: 'body' | 'headers' | 'timing';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ResponseActions {
  setLoading: () => void;
  setResponse: (response: HttpResponseDef) => void;
  setError: (error: ResponseError) => void;
  reset: () => void;
  setActiveTab: (tab: ResponseState['activeTab']) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ResponseStore = ResponseState & ResponseActions;

export const useResponseStore = create<ResponseStore>((set) => ({
  status: 'idle',
  response: null,
  error: null,
  activeTab: 'body',

  setLoading: () => set({ status: 'loading', error: null }),
  setResponse: (response) => set({ status: 'success', response, error: null }),
  setError: (error) => set({ status: 'error', error, response: null }),
  // activeTab is intentionally preserved so the user's tab selection survives
  // across requests (e.g., staying on Headers or Timing).
  reset: () => set({ status: 'idle', response: null, error: null }),
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
