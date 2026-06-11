# Design: Volt MVP

## Technical Approach

Greenfield VS Code extension with dual-process architecture: extension host (Node.js/CJS) owns HTTP execution, file I/O, and variable resolution; webview (React 18/Vite/ESM) owns the UI. Communication via typed postMessage discriminated unions. Collections live as YAML files in `.volt/` (git-friendly, zero vendor lock-in).

## Architecture Decisions

| Decision | Choice | Alternatives Rejected | Rationale |
|----------|--------|----------------------|-----------|
| HTTP engine | undici + diagnostics_channel | axios, got, node-fetch | Per-phase timing (DNS/TCP/TLS/TTFB) via diagnostics_channel hooks; already bundled in Node 18+ |
| Bundler (extension) | esbuild | webpack, rollup | Sub-second builds, CJS output for VS Code host, no plugin complexity |
| Bundler (webview) | Vite | esbuild, webpack | HMR in dev, React Fast Refresh, single-bundle production output |
| State management | Zustand | Redux, Jotai, Context | Minimal boilerplate, no providers, selector-based re-renders |
| Collection format | YAML (one file per request) | JSON, SQLite | Human-readable, git-diffable, structured enough for ajv validation |
| Message protocol | Discriminated unions (`type` field) | Event emitter, RPC framework | Type-safe at compile time, zero runtime deps, pattern-matchable |
| Theming | `var(--vscode-*)` mapped to design tokens | Custom theme engine | Zero-config, always matches user's active VS Code theme |

## Data Flow

```
┌─────────────── WEBVIEW (React/Vite) ─────────────────┐
│                                                       │
│  RequestBuilder ──→ requestStore ──→ postMessage      │
│                                         │             │
│  ResponseViewer ←── responseStore ←─────┤             │
│                                         │             │
│  CollectionTree ←── collectionStore ←───┤             │
└─────────────────────────────────────────┼─────────────┘
                                          │ postMessage
┌─────────────── EXTENSION HOST (Node) ───┼─────────────┐
│                                         │             │
│  MessageRouter ─────────────────────────┘             │
│       │                                               │
│       ├──→ HttpService.execute(req) → TimedResponse   │
│       ├──→ CollectionService.save/load/watch          │
│       └──→ EnvironmentService.resolve(vars)           │
│                                                       │
│  TreeDataProvider ←── CollectionService (file watch)  │
└───────────────────────────────────────────────────────┘
```

**Request lifecycle**: Builder UI → serialize to `ExecuteRequest` msg → MessageRouter → EnvironmentService interpolates `{{vars}}` → HttpService fires undici request → streams `ExecuteResponse` back → webview responseStore updates → ResponseViewer renders.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Create | Extension manifest, scripts, dependencies |
| `tsconfig.extension.json` | Create | Node/CJS config for extension host |
| `tsconfig.webview.json` | Create | ESNext/ESM config for React webview |
| `esbuild.config.mjs` | Create | Extension host bundler |
| `vite.config.ts` | Create | Webview bundler (React, single bundle output) |
| `src/extension/activate.ts` | Create | Extension entry: commands, providers, lifecycle |
| `src/extension/services/http-service.ts` | Create | undici wrapper, diagnostics_channel timing |
| `src/extension/services/collection-service.ts` | Create | YAML CRUD, FileSystemWatcher |
| `src/extension/services/environment-service.ts` | Create | Variable scoping + `{{var}}` interpolation |
| `src/extension/providers/webview-provider.ts` | Create | Panel lifecycle, HTML generation, CSP, nonce |
| `src/extension/providers/collection-tree-provider.ts` | Create | TreeDataProvider for sidebar |
| `src/extension/message-router.ts` | Create | Dispatches incoming messages to services |
| `src/shared/protocol.ts` | Create | Discriminated union message types |
| `src/shared/models.ts` | Create | Domain models (Request, Response, Environment, Timing) |
| `src/shared/schemas.ts` | Create | ajv JSON schemas for YAML validation |
| `src/webview/main.tsx` | Create | React entry point |
| `src/webview/App.tsx` | Create | Layout shell: split pane (builder | response) |
| `src/webview/stores/request-store.ts` | Create | Zustand: current request state |
| `src/webview/stores/response-store.ts` | Create | Zustand: response data + loading state |
| `src/webview/stores/collection-store.ts` | Create | Zustand: collection tree data |
| `src/webview/stores/env-store.ts` | Create | Zustand: active environment + variables |
| `src/webview/components/RequestBuilder.tsx` | Create | Method/URL/headers/body/params tabs |
| `src/webview/components/ResponseViewer.tsx` | Create | Body/headers/timing tabs |
| `src/webview/components/TimingBar.tsx` | Create | Horizontal stacked bar (DNS/TCP/TLS/TTFB/Body) |
| `src/webview/hooks/useMessage.ts` | Create | postMessage send/receive hook |
| `src/webview/styles/tokens.css` | Create | `--vscode-*` → design token mapping |

## Interfaces / Contracts

```typescript
// src/shared/protocol.ts — Message discriminated unions
type HostMessage =
  | { type: 'execute-request'; payload: HttpRequestDef }
  | { type: 'save-request'; payload: { path: string; request: HttpRequestDef } }
  | { type: 'load-collection' }
  | { type: 'set-environment'; payload: { name: string } }
  | { type: 'cancel-request'; payload: { id: string } };

type WebviewMessage =
  | { type: 'execute-response'; payload: HttpResponseDef }
  | { type: 'execute-error'; payload: { message: string; code?: string } }
  | { type: 'collection-loaded'; payload: CollectionTree }
  | { type: 'environment-changed'; payload: ResolvedEnv }
  | { type: 'request-progress'; payload: { phase: TimingPhase; elapsed: number } };

// src/shared/models.ts
interface HttpRequestDef {
  id: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: { type: 'json' | 'text' | 'form-data' | 'none'; content: string };
  queryParams: Array<{ key: string; value: string; enabled: boolean }>;
}

interface TimingBreakdown {
  dns: number;    // ms
  tcp: number;
  tls: number;
  ttfb: number;
  body: number;
  total: number;
}

interface HttpResponseDef {
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodySize: number;
  timing: TimingBreakdown;
}
```

## File Schemas

```yaml
# .volt/collection.yaml
name: "My API"
version: 1
order:
  - folder: auth
  - folder: users
  - request: health-check

# .volt/requests/auth/login.yaml
name: Login
method: POST
url: "{{baseUrl}}/auth/login"
headers:
  Content-Type: application/json
body:
  type: json
  content: |
    { "email": "{{email}}", "password": "{{password}}" }
queryParams: []

# .volt/envs/development.yaml
name: Development
variables:
  baseUrl: http://localhost:3000
  email: dev@example.com
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | HttpService timing, EnvironmentService interpolation, YAML parsing, message serialization | Vitest (fast, ESM-native, works with TypeScript) |
| Integration | postMessage round-trip, collection CRUD + file watcher | Vitest with mocked vscode API (`@vscode/test-electron` for real host) |
| E2E | Full request lifecycle, panel open/close/restore | `@vscode/test-electron` launching real VS Code instance |

## Migration / Rollout

No migration required. Greenfield project — ship when ready.

## Open Questions

- [x] Collection format: YAML per-file (decided in exploration)
- [x] Bundler split: esbuild host + Vite webview (decided in exploration)
- [ ] Max response body size before truncation in webview (suggest 5MB with streaming for larger)
- [ ] Whether to use `vscode.workspace.fs` API vs direct Node `fs` for collection I/O (portability to web extension vs. performance)
