# Tasks: Volt MVP

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 3500–4500 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 → PR 4 → PR 5 → PR 6 |
| Delivery strategy | ask-always |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Project bootstrap + shared types | PR 1 | Base branch: main. ~300 lines. Build pipeline compiles. |
| 2 | Extension scaffold + message router | PR 2 | Base: PR 1. ~350 lines. Extension activates, webview opens. |
| 3 | HTTP engine + environment service | PR 3 | Base: PR 2. ~400 lines. Can execute requests from host. |
| 4 | Collection persistence + tree view | PR 4 | Base: PR 3. ~350 lines. YAML CRUD + sidebar tree. |
| 5 | Webview UI: React scaffold + Request Builder + Response Viewer | PR 5 | Base: PR 4. ~400 lines. Full UI renders. |
| 6 | Integration: end-to-end flow + env switcher | PR 6 | Base: PR 5. ~350 lines. Complete MVP loop. |

---

## Phase 1: Project Bootstrap (~300 lines)

- [x] 1.1 Create `package.json` with extension manifest, scripts (`build`, `dev`, `package`), dependencies (undici, zustand, react, yaml, ajv), devDeps (esbuild, vite, vitest, eslint, prettier, @types/vscode). Satisfies cross-cutting size/compat constraints.
- [x] 1.2 Create `tsconfig.extension.json` (Node/CJS, strict, paths) and `tsconfig.webview.json` (ESNext/ESM, JSX react-jsx).
- [x] 1.3 Create `esbuild.config.mjs` — CJS bundle to `dist/extension.js`, external `vscode`. Satisfies REQ-EXT-001 activation speed.
- [x] 1.4 Create `vite.config.ts` — React plugin, single-bundle output to `dist/webview/`, base path `./`.
- [x] 1.5 Create `.eslintrc.cjs`, `.prettierrc`, `.vscodeignore`, `.gitignore`. Add ESLint flat config with @typescript-eslint.
- [x] 1.6 Create `src/shared/protocol.ts` — `HostMessage` and `WebviewMessage` discriminated unions with `correlationId`. Satisfies REQ-MSG-001.
- [x] 1.7 Create `src/shared/models.ts` — `HttpRequestDef`, `HttpResponseDef`, `TimingBreakdown`, `HttpMethod`, `CollectionTree` types. Satisfies REQ-HTTP-001, REQ-RV-004.

## Phase 2: Extension Scaffold + Message Router (~350 lines)

- [x] 2.1 Create `src/extension/activate.ts` — register commands (`volt.newRequest`, `volt.openCollection`, `volt.sendRequest`, `volt.switchEnvironment`), register WebviewProvider, register TreeDataProvider. Satisfies REQ-EXT-001, REQ-EXT-002.
- [x] 2.2 Create `src/extension/providers/webview-provider.ts` — singleton panel, CSP with nonce, `getHtmlForWebview()`, `WebviewPanelSerializer`. Satisfies REQ-EXT-003, REQ-EXT-005.
- [x] 2.3 Create `src/extension/message-router.ts` — receive `HostMessage`, dispatch to services, send `WebviewMessage`. Implement ready handshake queue. Satisfies REQ-MSG-001, REQ-MSG-002, REQ-MSG-006.
- [x] 2.4 Create `src/extension/providers/collection-tree-provider.ts` — empty TreeDataProvider shell (data loading in Phase 4). Satisfies REQ-EXT-004.

## Phase 3: HTTP Engine + Environment Service (~400 lines)

- [x] 3.1 Create `src/extension/services/http-service.ts` — undici `request()` wrapper, `AbortController` cancellation, redirect following (max 10), response size limit (50MB truncation). Satisfies REQ-HTTP-001, REQ-HTTP-003, REQ-HTTP-004, REQ-HTTP-006.
- [x] 3.2 Add `diagnostics_channel` hooks to `http-service.ts` — capture DNS/TCP/TLS/TTFB/download timing into `TimingBreakdown`. Satisfies REQ-HTTP-002.
- [x] 3.3 Add structured error handling to `http-service.ts` — map undici errors to typed error codes (`timeout`, `cancelled`, `dns_error`, `connection_refused`, `tls_error`). Satisfies REQ-HTTP-005, REQ-HTTP-007.
- [x] 3.4 Create `src/extension/services/environment-service.ts` — load `.volt/environments/*.yaml`, scope chain resolution (request → collection → project → global), `{{var}}` regex interpolation. Satisfies REQ-ENV-001, REQ-ENV-002, REQ-ENV-003.
- [x] 3.5 Create `src/shared/schemas.ts` — ajv JSON schemas for request YAML and environment YAML validation. Satisfies REQ-COL-003.

## Phase 4: Collection Persistence + Tree View (~350 lines)

- [x] 4.1 Create `src/extension/services/collection-service.ts` — read `.volt/collection.yaml`, load/save/delete request YAML files, create folders. Satisfies REQ-COL-002, REQ-COL-003, REQ-COL-005.
- [x] 4.2 Add `FileSystemWatcher` to `collection-service.ts` — watch `.volt/**/*.yaml`, debounce 100ms, emit change events. Satisfies REQ-COL-006.
- [x] 4.3 Complete `collection-tree-provider.ts` — populate tree from CollectionService data, method badge icons, folder icons, refresh on watcher events. Satisfies REQ-COL-001.
- [x] 4.4 Implement drag-and-drop reorder in tree provider — update `collection.yaml` order array, move files between folders. Satisfies REQ-COL-004.

## Phase 5: Webview UI (~400 lines)

- [ ] 5.1 Create `src/webview/main.tsx`, `src/webview/App.tsx` — React 18 entry, split-pane layout (builder left, response right), VS Code theme CSS variables.
- [ ] 5.2 Create `src/webview/styles/tokens.css` — map `--vscode-*` to design tokens. Create `src/webview/hooks/useMessage.ts` — postMessage send/subscribe with timeout (30s). Satisfies REQ-MSG-004, REQ-MSG-005.
- [ ] 5.3 Create `src/webview/stores/` — `request-store.ts`, `response-store.ts`, `collection-store.ts`, `env-store.ts` (Zustand slices).
- [ ] 5.4 Create `src/webview/components/RequestBuilder.tsx` — method dropdown, URL input with `{{var}}` highlight, headers table, body editor (JSON/text/none), query params table, Send/Cancel button. Satisfies REQ-RB-001 through REQ-RB-006.
- [ ] 5.5 Create `src/webview/components/ResponseViewer.tsx` — status badge (color-coded), body with syntax highlighting, headers table, empty/loading/error states. Satisfies REQ-RV-001, REQ-RV-002, REQ-RV-003, REQ-RV-006.
- [ ] 5.6 Create `src/webview/components/TimingBar.tsx` — horizontal stacked bar chart (DNS/TCP/TLS/TTFB/Download), hover tooltips with ms values. Satisfies REQ-RV-004.

## Phase 6: Integration + Polish (~350 lines)

- [ ] 6.1 Wire end-to-end: RequestBuilder → `request:send-http` → MessageRouter → EnvironmentService interpolates → HttpService executes → `response:send-http` → ResponseViewer renders. Satisfies REQ-MSG-003.
- [ ] 6.2 Wire collection: tree click → load request into builder, save request → YAML file → tree refresh. Satisfies REQ-COL-001, REQ-COL-002.
- [ ] 6.3 Implement environment switcher UI (dropdown in webview header) + `event:environment-changed` push. Satisfies REQ-ENV-005, REQ-ENV-006.
- [ ] 6.4 Implement copy actions: copy body, copy as cURL, save to file. Satisfies REQ-RV-005.
- [ ] 6.5 Add request tabs support — multiple open requests, unsaved indicator dot, tab switching. Satisfies REQ-RB-007.
- [ ] 6.6 Error edge cases: message timeout handling, graceful crash recovery, unhandled rejection guards. Satisfies REQ-MSG-002, REQ-MSG-004.
