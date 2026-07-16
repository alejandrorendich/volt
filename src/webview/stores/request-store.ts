/**
 * @fileoverview Request store — current request being composed.
 *
 * Holds the mutable draft of the HTTP request the user is building in the
 * RequestBuilder UI. Separate from the persisted YAML file; saving is an
 * explicit action that sends a `request:save-request` message to the host.
 *
 * Also manages the multi-tab state: each tab is an independent request draft.
 * REQ-RB-007 — multiple open requests with unsaved indicator; tab state is
 * snapshotted when switching away and restored when switching back.
 */

import { create } from 'zustand';
import type {
  HttpMethod,
  HttpRequestDef,
  RequestBody,
  QueryParam,
  AuthConfig,
  AssertionRule,
  AssertionResult,
} from '../../shared/models';

// ---------------------------------------------------------------------------
// Header row (with enabled toggle)
// ---------------------------------------------------------------------------

export interface HeaderRow {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly enabled: boolean;
}

/** A single form-data field row — same shape as HeaderRow, separate store. */
export interface FormDataRow {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export interface RequestTab {
  /** Stable tab identifier. */
  readonly tabId: string;
  /** Display name for the tab (e.g. "POST /login"). */
  name: string;
  /** Whether this tab has unsaved changes. */
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// Per-tab snapshot — captures the full mutable request state for a tab
// (REQ-RB-007)
// ---------------------------------------------------------------------------

export interface TabSnapshot {
  id: string;
  name: string;
  savePath: string | null;
  method: HttpMethod;
  url: string;
  baseUrl: string;
  headers: HeaderRow[];
  formDataRows: FormDataRow[];
  body: RequestBody;
  queryParams: QueryParam[];
  preScript: string;
  postScript: string;
  activeTab: 'params' | 'headers' | 'body' | 'scripts' | 'auth' | 'tests' | 'notes';
  sslVerify: boolean;
  followRedirects: boolean;
  timeout: number | null;
  auth: AuthConfig;
  assertions: AssertionRule[];
  notes: string;
  notesUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Request store state
// ---------------------------------------------------------------------------

export interface RequestState {
  /** Stable request ID (correlationId anchor). */
  id: string;
  /** Display name for the request. */
  name: string;
  /** Relative file path in .volt/requests/ (without extension). Null if unsaved. */
  savePath: string | null;
  method: HttpMethod;
  /** URL template — may contain {{variable}} placeholders. */
  url: string;
  /** Base URL without query params (derived from `url`). */
  baseUrl: string;
  headers: HeaderRow[];
  /** Rows for the form-data body editor (separate from HTTP headers). */
  formDataRows: FormDataRow[];
  body: RequestBody;
  queryParams: QueryParam[];
  /** Pre-request script (JavaScript). */
  preScript: string;
  /** Post-request script (JavaScript). */
  postScript: string;
  /** Active sub-tab in the builder panels. */
  activeTab: 'params' | 'headers' | 'body' | 'scripts' | 'auth' | 'tests' | 'notes';
  /** Whether TLS certificate verification is enabled. Default: true */
  sslVerify: boolean;
  /** Whether to follow 3xx redirects. Default: true */
  followRedirects: boolean;
  /** Request timeout in milliseconds. Null means use the default (30 s). */
  timeout: number | null;
  /** Authentication configuration for this request. Default: { type: 'none' } */
  auth: AuthConfig;
  /** GUI-based assertion rules for this request. */
  assertions: AssertionRule[];
  /** Results of the last assertion evaluation. Cleared on new request. */
  assertionResults: AssertionResult[];
  /** Notes for this request (Markdown supported). */
  notes: string;
  /** ISO timestamp of the last notes update. Empty string when unknown. */
  notesUpdatedAt: string;
  /** Whether a request is currently in-flight. */
  loading: boolean;
  /** CorrelationId of the active in-flight request (for cancel). */
  activeCorrelationId: string | null;

  // Multi-tab state (REQ-RB-007)
  /** List of open request tabs. */
  tabs: RequestTab[];
  /** ID of the currently active tab. */
  activeTabId: string;
  /** Per-tab state snapshots — keyed by tabId. */
  tabSnapshots: Map<string, TabSnapshot>;

  // Streaming progress (REQ-MSG-003)
  /** Current streaming phase label, or null when idle. */
  streamingPhase: string | null;

  // Script error feedback
  /** Non-null when the last pre/post script execution failed. Cleared on new request. */
  scriptError: { phase: 'pre' | 'post'; message: string } | null;

  /**
   * Snapshot of the body before it was switched to "none". Used to restore
   * content when the user toggles None → a real body type. Cleared when the
   * underlying body is edited directly (so an old None-hidden value never
   * overwrites new content).
   */
  lastNonNoneBody: RequestBody | null;
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
  /** Replace all headers at once (used by bulk-edit mode in KeyValueEditor). */
  replaceHeaders: (rows: HeaderRow[]) => void;

  // Form-data rows (separate from HTTP headers — C-02)
  addFormRow: () => void;
  updateFormRow: (id: string, patch: Partial<Pick<FormDataRow, 'key' | 'value' | 'enabled'>>) => void;
  removeFormRow: (id: string) => void;
  /** Replace all form-data rows at once (used by bulk-edit mode). */
  replaceFormRows: (rows: FormDataRow[]) => void;

  // Query params
  addParam: () => void;
  updateParam: (index: number, patch: Partial<QueryParam>) => void;
  removeParam: (index: number) => void;
  /** Replace all query params at once (used by bulk-edit mode). */
  replaceParams: (params: QueryParam[]) => void;

  // Body
  setBody: (body: RequestBody) => void;

  // Scripts
  setPreScript: (script: string) => void;
  setPostScript: (script: string) => void;

  // Load a full request (e.g. from collection tree click)
  loadRequest: (patch: Partial<Omit<RequestState, 'activeTab' | 'loading' | 'activeCorrelationId' | 'tabs' | 'activeTabId' | 'tabSnapshots' | 'streamingPhase'>>) => void;

  /** Build the final HttpRequestDef for sending. */
  toRequestDef: () => HttpRequestDef;

  // SSL verification toggle (F-05)
  setSslVerify: (sslVerify: boolean) => void;

  // Follow redirects toggle
  setFollowRedirects: (followRedirects: boolean) => void;

  // Timeout
  setTimeout: (timeout: number | null) => void;

  // Auth
  setAuth: (auth: AuthConfig) => void;

  // Tab management (REQ-RB-007)
  addTab: () => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  markDirty: () => void;

  // Streaming (REQ-MSG-003)
  setStreamingPhase: (phase: string | null) => void;

  // Script error feedback
  /** Set a script error to show in the Scripts tab. Pass null to clear. */
  setScriptError: (error: { phase: 'pre' | 'post'; message: string } | null) => void;

  // Assertions (Feature 5)
  addAssertion: () => void;
  updateAssertion: (id: string, patch: Partial<Omit<AssertionRule, 'id'>>) => void;
  removeAssertion: (id: string) => void;
  setAssertionResults: (results: AssertionResult[]) => void;

  // Notes
  setNotes: (payload: { notes: string; notesUpdatedAt: string }) => void;

  // Save
  /** Get the savePath for the current request. */
  getSavePath: () => string | null;
  /** Set the savePath after the request is associated with a file. */
  setSavePath: (path: string) => void;
  /** Mark as saved (clears dirty flag). */
  markSaved: () => void;
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

/**
 * Encode a query-param key or value, but skip encoding for template variable
 * references like `{{baseUrl}}` — they will be resolved at execution time.
 */
function encodeParam(s: string): string {
  if (/\{\{[a-zA-Z0-9_-]+\}\}/.test(s)) return s;
  return encodeURIComponent(s);
}

/** Rebuild the URL from baseUrl + queryParams. */
function buildUrl(baseUrl: string, params: QueryParam[]): string {
  const enabled = params.filter((p) => p.enabled && p.key.trim() !== '');
  if (enabled.length === 0) return baseUrl;
  const qs = enabled
    .map((p) => `${encodeParam(p.key)}=${encodeParam(p.value)}`)
    .join('&');
  return `${baseUrl}?${qs}`;
}

/** Derive a short display name for a tab from name, method + URL. */
function deriveTabName(method: HttpMethod, url: string, name?: string): string {
  if (name) return name;
  if (!url.trim()) return `${method} (new)`;
  try {
    const u = new URL(url);
    return `${method} ${u.pathname}`;
  } catch {
    // Not a fully-qualified URL — just show last segment
    const segments = url.split('/').filter(Boolean);
    const last = segments.at(-1) ?? url;
    return `${method} /${last.slice(0, 20)}`;
  }
}

/** Capture current request fields as a snapshot for a tab. */
function captureSnapshot(s: RequestState): TabSnapshot {
  return {
    id: s.id,
    name: s.name,
    savePath: s.savePath,
    method: s.method,
    url: s.url,
    baseUrl: s.baseUrl,
    headers: s.headers,
    formDataRows: s.formDataRows,
    body: s.body,
    queryParams: s.queryParams,
    preScript: s.preScript,
    postScript: s.postScript,
    activeTab: s.activeTab,
    sslVerify: s.sslVerify,
    followRedirects: s.followRedirects,
    timeout: s.timeout,
    auth: s.auth,
    assertions: s.assertions,
    notes: s.notes,
    notesUpdatedAt: s.notesUpdatedAt,
  };
}

/** Restore request fields from a snapshot. */
function applySnapshot(snapshot: TabSnapshot): Partial<RequestState> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    savePath: snapshot.savePath,
    method: snapshot.method,
    url: snapshot.url,
    baseUrl: snapshot.baseUrl,
    headers: snapshot.headers,
    formDataRows: snapshot.formDataRows,
    body: snapshot.body,
    queryParams: snapshot.queryParams,
    preScript: snapshot.preScript,
    postScript: snapshot.postScript,
    activeTab: snapshot.activeTab,
    sslVerify: snapshot.sslVerify,
    followRedirects: snapshot.followRedirects,
    timeout: snapshot.timeout,
    auth: snapshot.auth,
    assertions: snapshot.assertions,
    notes: snapshot.notes,
    notesUpdatedAt: snapshot.notesUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type RequestStore = RequestState & RequestActions;

const initialTabId = generateId();

const INITIAL_SNAPSHOT: TabSnapshot = {
  id: generateId(),
  name: '',
  savePath: null,
  method: 'GET',
  url: '',
  baseUrl: '',
  headers: [
    { id: generateId(), key: 'Content-Type', value: 'application/json', enabled: true },
    { id: generateId(), key: 'Accept', value: '*/*', enabled: true },
    { id: generateId(), key: '', value: '', enabled: true },
  ],
  formDataRows: [{ id: generateId(), key: '', value: '', enabled: true }],
  body: { type: 'none' },
  queryParams: [{ key: '', value: '', enabled: true }],
  preScript: '',
  postScript: '',
  activeTab: 'params',
  sslVerify: true,
  followRedirects: true,
  timeout: null,
  auth: { type: 'none' },
  assertions: [],
  notes: '',
  notesUpdatedAt: '',
};

export const useRequestStore = create<RequestStore>((set, get) => ({
  // Initial state
  ...INITIAL_SNAPSHOT,
  name: '',
  savePath: null,
  loading: false,
  activeCorrelationId: null,
  tabs: [{ tabId: initialTabId, name: 'GET (new)', dirty: false }],
  activeTabId: initialTabId,
  tabSnapshots: new Map(),
  streamingPhase: null,
  scriptError: null,
  assertionResults: [],
  lastNonNoneBody: null,

  // Actions
  setMethod: (method) => {
    set({ method });
    // Update tab name
    const s = get();
    set({
      tabs: s.tabs.map((t) =>
        t.tabId === s.activeTabId ? { ...t, name: deriveTabName(method, s.url, s.name), dirty: true } : t,
      ),
    });
  },

  setUrl: (url) => {
    const { params } = parseUrlParams(url);
    if (params.length > 0) {
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
    // Update tab name + mark dirty
    const s = get();
    set({
      tabs: s.tabs.map((t) =>
        t.tabId === s.activeTabId ? { ...t, name: deriveTabName(s.method, url, s.name), dirty: true } : t,
      ),
    });
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  setLoading: (loading, correlationId) => {
    const patch: Partial<RequestState> = {
      loading,
      activeCorrelationId: correlationId !== undefined ? correlationId : get().activeCorrelationId,
    };
    // Clear any script error and assertion results when a new request starts
    if (loading) {
      patch.scriptError = null;
      patch.assertionResults = [];
    }
    set(patch);
  },

  addHeader: () => {
    set((s) => ({
      headers: [...s.headers, { id: generateId(), key: '', value: '', enabled: true }],
    }));
    get().markDirty();
  },

  updateHeader: (id, patch) => {
    set((s) => ({
      headers: s.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
    get().markDirty();
  },

  removeHeader: (id) => {
    set((s) => ({
      headers: s.headers.filter((h) => h.id !== id),
    }));
    get().markDirty();
  },

  replaceHeaders: (rows) => {
    // Always ensure a trailing empty row for user input
    const withTrailer = [...rows, { id: generateId(), key: '', value: '', enabled: true }];
    set({ headers: withTrailer });
    get().markDirty();
  },

  // Form-data row actions — independent from HTTP headers (C-02)
  addFormRow: () =>
    set((s) => ({
      formDataRows: [...s.formDataRows, { id: generateId(), key: '', value: '', enabled: true }],
    })),

  updateFormRow: (id, patch) =>
    set((s) => ({
      formDataRows: s.formDataRows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    })),

  removeFormRow: (id) =>
    set((s) => ({
      formDataRows: s.formDataRows.filter((r) => r.id !== id),
    })),

  replaceFormRows: (rows) => {
    const withTrailer = [...rows, { id: generateId(), key: '', value: '', enabled: true }];
    set({ formDataRows: withTrailer });
    get().markDirty();
  },

  addParam: () => {
    set((s) => {
      const newParams: QueryParam[] = [...s.queryParams, { key: '', value: '', enabled: true }];
      return { queryParams: newParams, url: buildUrl(s.baseUrl, newParams) };
    });
    get().markDirty();
  },

  updateParam: (index, patch) => {
    set((s) => {
      const newParams = s.queryParams.map((p, i) => (i === index ? { ...p, ...patch } : p));
      return { queryParams: newParams, url: buildUrl(s.baseUrl, newParams) };
    });
    get().markDirty();
  },

  removeParam: (index) => {
    set((s) => {
      const newParams = s.queryParams.filter((_, i) => i !== index);
      return { queryParams: newParams, url: buildUrl(s.baseUrl, newParams) };
    });
    get().markDirty();
  },

  replaceParams: (params) => {
    const withTrailer = [...params, { key: '', value: '', enabled: true }];
    set((s) => ({ queryParams: withTrailer, url: buildUrl(s.baseUrl, withTrailer) }));
    get().markDirty();
  },

  setBody: (body) => {
    const prev = get().body;
    // Track "last non-none body" so we can restore when toggling None → type.
    // Snapshot only when leaving a real type for 'none'. Don't overwrite a
    // saved snapshot while still in 'none' (preserves the original restore target).
    let lastNonNoneBody = get().lastNonNoneBody;
    if (body.type === 'none' && prev.type !== 'none') {
      lastNonNoneBody = prev;
    }
    set({ body, lastNonNoneBody });
    get().markDirty();
  },

  setPreScript: (preScript) => {
    set({ preScript });
    get().markDirty();
  },
  setPostScript: (postScript) => {
    set({ postScript });
    get().markDirty();
  },

  loadRequest: (patch) =>
    set((s) => {
      const baseUrl = patch.url ? parseUrlParams(patch.url).baseUrl : s.baseUrl;
      const newMethod = (patch.method) ?? s.method;
      const newUrl = patch.url ?? s.url;
      const newName = patch.name ?? s.name;
      // Update the active tab name to reflect the loaded request
      const updatedTabs = s.tabs.map((t) =>
        t.tabId === s.activeTabId
          ? { ...t, name: deriveTabName(newMethod, newUrl, newName), dirty: false }
          : t,
      );
      return { ...patch, baseUrl, tabs: updatedTabs };
    }),

  toRequestDef: () => {
    const s = get();
    const filteredHeaders: Record<string, string> = {};
    for (const h of s.headers) {
      if (h.enabled && h.key.trim() !== '') {
        filteredHeaders[h.key.trim()] = h.value;
      }
    }

    // For form-data: serialise formDataRows into "key=value\n..." content (C-02)
    let body: RequestBody | undefined = s.body.type === 'none' ? undefined : s.body;
    if (s.body.type === 'form-data') {
      const content = s.formDataRows
        .filter((r) => r.enabled && r.key.trim() !== '')
        .map((r) => `${r.key.trim()}=${r.value}`)
        .join('\n');
      body = { type: 'form-data', content };
    }

    return {
      id: s.id,
      name: s.name || '',
      method: s.method,
      url: s.url,
      headers: filteredHeaders,
      ...(body !== undefined ? { body } : {}),
      queryParams: s.queryParams.filter((p) => p.key.trim() !== ''),
      ...(s.notes ? { notes: s.notes } : {}),
      ...(s.notesUpdatedAt ? { notesUpdatedAt: s.notesUpdatedAt } : {}),
      ...(s.preScript ? { preScript: s.preScript } : {}),
      ...(s.postScript ? { postScript: s.postScript } : {}),
      ...(s.auth.type !== 'none' ? { auth: s.auth } : {}),
      ...(s.timeout !== null ? { timeout: s.timeout } : {}),
      ...(!s.sslVerify || !s.followRedirects
        ? {
            settings: {
              ...(!s.sslVerify ? { sslVerify: false } : {}),
              ...(!s.followRedirects ? { followRedirects: false } : {}),
            },
          }
        : {}),
      ...(s.assertions.length > 0 ? { assertions: s.assertions } : {}),
    };
  },

  // Tab management (REQ-RB-007)

  addTab: () => {
    const tabId = generateId();
    const newSnapshot: TabSnapshot = {
      id: generateId(),
      name: '',
      savePath: null,
      method: 'GET',
      url: '',
      baseUrl: '',
      headers: [
        { id: generateId(), key: 'Content-Type', value: 'application/json', enabled: true },
        { id: generateId(), key: 'Accept', value: '*/*', enabled: true },
        { id: generateId(), key: '', value: '', enabled: true },
      ],
      formDataRows: [{ id: generateId(), key: '', value: '', enabled: true }],
      body: { type: 'none' },
      queryParams: [{ key: '', value: '', enabled: true }],
      preScript: '',
      postScript: '',
      activeTab: 'params',
      sslVerify: true,
      followRedirects: true,
      timeout: null,
      auth: { type: 'none' },
      assertions: [],
      notes: '',
      notesUpdatedAt: '',
    };
    set((s) => {
      // Save current tab's state before switching
      const updatedSnapshots = new Map(s.tabSnapshots);
      updatedSnapshots.set(s.activeTabId, captureSnapshot(s));
      updatedSnapshots.set(tabId, newSnapshot);
      return {
        ...applySnapshot(newSnapshot),
        loading: false,
        activeCorrelationId: null,
        tabs: [...s.tabs, { tabId, name: 'GET (new)', dirty: false }],
        activeTabId: tabId,
        tabSnapshots: updatedSnapshots,
        streamingPhase: null,
      };
    });
  },

  closeTab: (tabId) => {
    const s = get();
    if (s.tabs.length <= 1) return; // Cannot close the last tab

    const remaining = s.tabs.filter((t) => t.tabId !== tabId);
    const fallbackTab = remaining.at(-1) ?? remaining.at(0);
    const newActiveTabId = s.activeTabId === tabId
      ? (fallbackTab?.tabId ?? s.activeTabId)
      : s.activeTabId;

    // Clean up snapshot for closed tab
    const updatedSnapshots = new Map(s.tabSnapshots);
    updatedSnapshots.delete(tabId);

    if (s.activeTabId === tabId && newActiveTabId !== tabId) {
      // Restore the new active tab's snapshot
      const restoredSnapshot = updatedSnapshots.get(newActiveTabId);
      if (restoredSnapshot) {
        set({
          ...applySnapshot(restoredSnapshot),
          tabs: remaining,
          activeTabId: newActiveTabId,
          tabSnapshots: updatedSnapshots,
        });
        return;
      }
    }

    set({ tabs: remaining, activeTabId: newActiveTabId, tabSnapshots: updatedSnapshots });
  },

  switchTab: (tabId) => {
    // REQ-RB-007: snapshot current state, restore target tab state
    const s = get();
    if (tabId === s.activeTabId) return;

    const updatedSnapshots = new Map(s.tabSnapshots);
    // Save current tab's state
    updatedSnapshots.set(s.activeTabId, captureSnapshot(s));

    const targetSnapshot = updatedSnapshots.get(tabId);
    if (targetSnapshot) {
      set({
        ...applySnapshot(targetSnapshot),
        activeTabId: tabId,
        tabSnapshots: updatedSnapshots,
        loading: false,
        activeCorrelationId: null,
        streamingPhase: null,
      });
    } else {
      // No snapshot yet — switch with a fresh state
      const freshSnapshot: TabSnapshot = {
        id: generateId(),
        name: '',
        savePath: null,
        method: 'GET',
        url: '',
        baseUrl: '',
        headers: [
          { id: generateId(), key: 'Content-Type', value: 'application/json', enabled: true },
          { id: generateId(), key: 'Accept', value: '*/*', enabled: true },
          { id: generateId(), key: '', value: '', enabled: true },
        ],
        formDataRows: [{ id: generateId(), key: '', value: '', enabled: true }],
        body: { type: 'none' },
        queryParams: [{ key: '', value: '', enabled: true }],
        preScript: '',
        postScript: '',
        activeTab: 'params',
        sslVerify: true,
        followRedirects: true,
        timeout: null,
        auth: { type: 'none' },
        assertions: [],
        notes: '',
        notesUpdatedAt: '',
      };
      updatedSnapshots.set(tabId, freshSnapshot);
      set({
        ...applySnapshot(freshSnapshot),
        activeTabId: tabId,
        tabSnapshots: updatedSnapshots,
        loading: false,
        activeCorrelationId: null,
        streamingPhase: null,
      });
    }
  },

  markDirty: () => {
    const s = get();
    set({
      tabs: s.tabs.map((t) =>
        t.tabId === s.activeTabId ? { ...t, dirty: true } : t,
      ),
    });
  },

  setStreamingPhase: (phase) => set({ streamingPhase: phase }),

  setScriptError: (error) => set({ scriptError: error }),

  setSslVerify: (sslVerify) => {
    set({ sslVerify });
    get().markDirty();
  },

  setFollowRedirects: (followRedirects) => {
    set({ followRedirects });
    get().markDirty();
  },

  setTimeout: (timeout) => {
    set({ timeout });
    get().markDirty();
  },

  setAuth: (auth) => {
    set({ auth });
    get().markDirty();
  },

  // Assertions (Feature 5)
  addAssertion: () => {
    const newRule: AssertionRule = {
      id: generateId(),
      subject: 'status',
      property: '',
      operator: 'eq',
      expected: '',
    };
    set((s) => ({ assertions: [...s.assertions, newRule] }));
    get().markDirty();
  },

  updateAssertion: (id, patch) => {
    set((s) => ({
      assertions: s.assertions.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
    get().markDirty();
  },

  removeAssertion: (id) => {
    set((s) => ({
      assertions: s.assertions.filter((a) => a.id !== id),
    }));
    get().markDirty();
  },

  setAssertionResults: (results) => set({ assertionResults: results }),

  setNotes: (payload) => {
    set({ notes: payload.notes, notesUpdatedAt: payload.notesUpdatedAt });
    get().markDirty();
  },

  getSavePath: () => get().savePath,
  setSavePath: (path) => set({ savePath: path }),
  markSaved: () => {
    const s = get();
    set({
      tabs: s.tabs.map((t) =>
        t.tabId === s.activeTabId ? { ...t, dirty: false } : t,
      ),
    });
  },
}));
