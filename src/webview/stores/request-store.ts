/**
 * @fileoverview Request store — current request being composed.
 *
 * Holds the mutable draft of the HTTP request the user is building in the
 * RequestBuilder UI. Separate from the persisted YAML file; saving is an
 * explicit action that sends a `save-request` message to the host.
 */

import { create } from 'zustand';
import type { HttpMethod, RequestBody, QueryParam } from '../../../shared/models';

// ---------------------------------------------------------------------------
// Header row (with enabled toggle)
// ---------------------------------------------------------------------------

export interface HeaderRow {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// Request store state
// ---------------------------------------------------------------------------

export interface RequestState {
  /** Stable request ID (correlationId anchor). */
  id: string;
  method: HttpMethod;
  /** URL template — may contain {{variable}} placeholders. */
  url: string;
  /** Base URL without query params (derived from `url`). */
  baseUrl: string;
  headers: HeaderRow[];
  body: RequestBody;
  queryParams: QueryParam[];
  /** Active sub-tab in the builder panels. */
  activeTab: 'params' | 'headers' | 'body';
  /** Whether a request is currently in-flight. */
  loading: boolean;
  /** CorrelationId of the active in-flight request (for cancel). */
  activeCorrelationId: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface RequestActions {
  setMethod: (method: HttpMethod) => void;
  setUrl: (url: string) => void;
  setActiveTab: (tab: RequestState['activeTab']) => void;
  setLoading: (loading: boolean, correlationId?: string | null) => void;

  // Headers
  addHeader: () => void;
  updateHeader: (id: string, patch: Partial<Pick<HeaderRow, 'key' | 'value' | 'enabled'>>) => void;
  removeHeader: (id: string) => void;

  // Query params
  addParam: () => void;
  updateParam: (index: number, patch: Partial<QueryParam>) => void;
  removeParam: (index: number) => void;

  // Body
  setBody: (body: RequestBody) => void;

  // Load a full request (e.g. from collection tree click)
  loadRequest: (patch: Partial<Omit<RequestState, 'activeTab' | 'loading' | 'activeCorrelationId'>>) => void;

  /** Build the final HttpRequestDef for sending. */
  toRequestDef: () => import('../../../shared/models').HttpRequestDef;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Parse query params from a URL string. */
function parseUrlParams(url: string): { baseUrl: string; params: QueryParam[] } {
  try {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return { baseUrl: url, params: [] };
    const base = url.slice(0, qIdx);
    const search = url.slice(qIdx + 1);
    const params: QueryParam[] = search
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const eqIdx = pair.indexOf('=');
        const key = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
        const value = eqIdx === -1 ? '' : pair.slice(eqIdx + 1);
        return { key: decodeURIComponent(key), value: decodeURIComponent(value), enabled: true };
      });
    return { baseUrl: base, params };
  } catch {
    return { baseUrl: url, params: [] };
  }
}

/** Rebuild the URL from baseUrl + queryParams. */
function buildUrl(baseUrl: string, params: QueryParam[]): string {
  const enabled = params.filter((p) => p.enabled && p.key.trim() !== '');
  if (enabled.length === 0) return baseUrl;
  const qs = enabled
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&');
  return `${baseUrl}?${qs}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type RequestStore = RequestState & RequestActions;

export const useRequestStore = create<RequestStore>((set, get) => ({
  // Initial state
  id: generateId(),
  method: 'GET',
  url: '',
  baseUrl: '',
  headers: [{ id: generateId(), key: '', value: '', enabled: true }],
  body: { type: 'none' },
  queryParams: [{ key: '', value: '', enabled: true }],
  activeTab: 'params',
  loading: false,
  activeCorrelationId: null,

  // Actions
  setMethod: (method) => set({ method }),

  setUrl: (url) => {
    const { params } = parseUrlParams(url);
    if (params.length > 0) {
      // Auto-extract query params — keep trailing empty row
      const qIdx = url.indexOf('?');
      const baseUrl = qIdx === -1 ? url : url.slice(0, qIdx);
      set({
        url,
        baseUrl,
        queryParams: [...params, { key: '', value: '', enabled: true }],
      });
    } else {
      set({ url, baseUrl: url });
    }
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  setLoading: (loading, correlationId) =>
    set({ loading, activeCorrelationId: correlationId !== undefined ? correlationId : get().activeCorrelationId }),

  addHeader: () =>
    set((s) => ({
      headers: [...s.headers, { id: generateId(), key: '', value: '', enabled: true }],
    })),

  updateHeader: (id, patch) =>
    set((s) => ({
      headers: s.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    })),

  removeHeader: (id) =>
    set((s) => ({
      headers: s.headers.filter((h) => h.id !== id),
    })),

  addParam: () =>
    set((s) => {
      const newParams: QueryParam[] = [...s.queryParams, { key: '', value: '', enabled: true }];
      return { queryParams: newParams, url: buildUrl(s.baseUrl, newParams) };
    }),

  updateParam: (index, patch) =>
    set((s) => {
      const newParams = s.queryParams.map((p, i) => (i === index ? { ...p, ...patch } : p));
      return { queryParams: newParams, url: buildUrl(s.baseUrl, newParams) };
    }),

  removeParam: (index) =>
    set((s) => {
      const newParams = s.queryParams.filter((_, i) => i !== index);
      return { queryParams: newParams, url: buildUrl(s.baseUrl, newParams) };
    }),

  setBody: (body) => set({ body }),

  loadRequest: (patch) =>
    set((s) => {
      const baseUrl = patch.url ? parseUrlParams(patch.url).baseUrl : s.baseUrl;
      return { ...patch, baseUrl };
    }),

  toRequestDef: () => {
    const s = get();
    const filteredHeaders: Record<string, string> = {};
    for (const h of s.headers) {
      if (h.enabled && h.key.trim() !== '') {
        filteredHeaders[h.key.trim()] = h.value;
      }
    }
    return {
      id: s.id,
      method: s.method,
      url: s.url,
      headers: filteredHeaders,
      body: s.body.type === 'none' ? undefined : s.body,
      queryParams: s.queryParams.filter((p) => p.key.trim() !== ''),
    };
  },
}));
