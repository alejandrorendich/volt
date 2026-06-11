/**
 * @fileoverview Collection Runner store — tracks the state of a running
 * or completed collection run.
 *
 * Updated by the message handler when `event:runner-progress` or
 * `event:runner-complete` arrives.
 */

import { create } from 'zustand';

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

export interface RunnerResult {
  readonly index: number;
  readonly requestName: string;
  readonly status: number;
  readonly time: number;
  readonly pass: boolean;
  readonly assertionsPassed: number;
  readonly assertionsTotal: number;
}

export interface RunnerSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly totalTime: number;
}

export type RunnerStatus = 'idle' | 'running' | 'complete';

export interface RunnerState {
  status: RunnerStatus;
  folderName: string;
  results: RunnerResult[];
  summary: RunnerSummary | null;
  total: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface RunnerActions {
  startRun: (folderName: string, total?: number) => void;
  addProgress: (result: RunnerResult & { total: number }) => void;
  complete: (summary: RunnerSummary) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type RunnerStore = RunnerState & RunnerActions;

export const useRunnerStore = create<RunnerStore>((set) => ({
  status: 'idle',
  folderName: '',
  results: [],
  summary: null,
  total: 0,

  startRun: (folderName, total = 0) =>
    set({ status: 'running', folderName, results: [], summary: null, total }),

  addProgress: ({ total, ...result }) =>
    set((state) => ({
      results: [...state.results, result],
      total,
    })),

  complete: (summary) => set({ status: 'complete', summary }),

  reset: () =>
    set({ status: 'idle', folderName: '', results: [], summary: null, total: 0 }),
}));
