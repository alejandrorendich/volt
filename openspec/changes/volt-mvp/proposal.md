# Proposal: Volt MVP — VS Code HTTP Client Extension

## Intent

Developers need a free, fast, git-integrated HTTP client inside VS Code. Current options paywall essential features (Thunder Client), cache responses unreliably (Postman), or run as separate Electron apps (Bruno). Volt delivers a professional HTTP client as a VS Code extension with file-based YAML collections, response timing breakdown, and zero paywalls.

## Scope

### In Scope
- Extension scaffold with lazy activation (`workspaceContains:.volt/collection.yaml`)
- Webview UI: React 18 + Vite, method/URL/headers/body/query-params builder
- HTTP execution via undici with per-phase timing (DNS/TCP/TLS/TTFB/Body)
- Response viewer: body (formatted JSON/XML/text), headers, status, timing visualization
- Collection management: create/edit/delete requests, organize in folders, drag-and-drop
- YAML file persistence: one file per request in `.volt/` directory structure
- Environment variables: project + request scope, `{{var}}` interpolation
- VS Code theme integration via `var(--vscode-*)` CSS variables
- Typed postMessage communication (discriminated unions)
- Zustand state management in webview

### Out of Scope
- Pre/post request scripts (quickjs-emscripten) — v1.1
- Import from Postman/Thunder Client/Insomnia — v1.1
- WebSocket/SSE/GraphQL support — v1.1
- Request history — v1.1
- Advanced auth helpers (OAuth2 flows) — v1.1
- Secret management (`.secrets.local.yaml`) — v1.1
- Marketplace publishing — post-MVP
- Monaco editor for body/scripts — v1.1

## Capabilities

### New Capabilities
- `extension-scaffold`: VS Code extension activation, commands, webview panel lifecycle
- `http-engine`: Request execution via undici with cancellation, streaming, timing breakdown
- `request-builder`: Webview UI for composing HTTP requests (method, URL, headers, body, params)
- `response-viewer`: Display response body, headers, status code, and timing visualization
- `collection-management`: CRUD operations on requests/folders, file-system persistence in YAML
- `environment-variables`: Variable resolution with project→request scoping, `{{var}}` interpolation
- `webview-communication`: Typed postMessage protocol between extension host and React webview

### Modified Capabilities
None — greenfield project, no existing specs.

## Approach

1. **Scaffold**: VS Code extension + dual tsconfig (extension host: Node/CJS, webview: ESNext/Vite)
2. **Core first**: undici HTTP engine with timing extraction via diagnostics_channel
3. **Communication layer**: Typed message protocol (`shared/messages.ts`) with discriminated unions
4. **UI shell**: React 18 + Zustand webview with split-pane layout, theme-aware CSS
5. **Request flow**: Builder → serialize → postMessage → undici execute → stream response back
6. **Persistence**: YAML read/write with ajv schema validation, file watchers for external changes
7. **Variables**: Resolver chain (request → project → global), interpolate before execution

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `package.json` | New | Extension manifest, dependencies, activation events |
| `src/extension.ts` | New | Activation, command registration, webview panel |
| `src/core/http-engine.ts` | New | undici wrapper with timing breakdown |
| `src/core/collection-manager.ts` | New | YAML CRUD, file watchers |
| `src/core/env-resolver.ts` | New | Variable scoping and interpolation |
| `src/shared/messages.ts` | New | Typed postMessage protocol |
| `src/webview/` | New | React 18 + Vite app (builder, viewer, tree) |
| `.volt/` | New | Collection directory structure (user workspace) |
| `vite.config.ts` | New | Webview bundler configuration |
| `tsconfig.extension.json` | New | Extension host TypeScript config |
| `tsconfig.webview.json` | New | Webview TypeScript config |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| undici timing API instability | Low | Pin version, abstract behind interface |
| Large webview bundle (React + Zustand) | Low | Tree-shake aggressively, lazy-load panels |
| VS Code theme coverage gaps | Med | Test 6+ themes, provide fallback values |
| File watcher perf in monorepos | Low | Scope watchers to `.volt/` root only |
| YAML parse security | Low | Use js-yaml v4+ safe defaults, validate with ajv |

## Rollback Plan

Extension is additive — no existing functionality to break. Rollback = uninstall extension. For development iterations: git revert to previous working state. The `.volt/` directory is inert YAML files with no side effects if the extension is removed.

## Dependencies

- Node.js >= 18 (for undici compatibility)
- VS Code >= 1.85 (Webview API stability, `WebviewPanelSerializer`)
- `@anthropic-ai/sdk` is NOT a dependency (fully offline, no AI in MVP)

## Success Criteria

- [ ] Extension installs and activates lazily on `.volt/collection.yaml` detection
- [ ] Can compose and send HTTP requests (GET/POST/PUT/PATCH/DELETE)
- [ ] Response displays body, headers, status, and timing breakdown (DNS/TCP/TLS/TTFB/Body)
- [ ] Requests persist as individual YAML files in `.volt/requests/`
- [ ] Collections organizable in folders via UI
- [ ] Environment variables resolve with `{{var}}` syntax at project and request scope
- [ ] UI matches active VS Code theme (light, dark, high contrast)
- [ ] Extension startup adds zero activation cost when no `.volt/` directory present
