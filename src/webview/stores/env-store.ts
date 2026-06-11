/**
 * @fileoverview Environment store — active environment and available envs.
 *
 * Updated when an `environment-changed` WebviewMessage arrives from the host.
 * The resolved variable map is used by components that want to preview
 * interpolated values.
 */

import { create } from 'zustand';
import type { ResolvedEnv } from '../../shared/models';

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface EnvState {
  active: string;
  available: readonly string[];
  variables: Record<string, string>;
}

export interface EnvActions {
  setEnv: (env: ResolvedEnv) => void;
  setActive: (name: string) => void;
}

export type EnvStore = EnvState & EnvActions;

export const useEnvStore = create<EnvStore>((set) => ({
  active: '',
  available: [],
  variables: {},

  setEnv: (env) =>
    set({
      active: env.active,
      available: env.available,
      variables: env.variables,
    }),

  setActive: (name) => set({ active: name }),
}));
