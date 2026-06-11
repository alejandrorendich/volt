# Volt MVP — Delta Specifications

## Domains

| Domain | Type | Requirements | Scenarios |
|--------|------|-------------|-----------|
| extension-scaffold | New | 5 | 8 |
| http-engine | New | 7 | 11 |
| request-builder | New | 7 | 11 |
| response-viewer | New | 6 | 11 |
| collection-management | New | 6 | 9 |
| environment-variables | New | 6 | 9 |
| webview-communication | New | 6 | 10 |
| **Total** | | **43** | **69** |

## Spec Index

- [Extension Scaffold](specs/extension-scaffold/spec.md) — Activation, commands, webview panel, sidebar, CSP
- [HTTP Engine](specs/http-engine/spec.md) — Execution, timing, cancellation, redirects, errors, size limits, TLS
- [Request Builder](specs/request-builder/spec.md) — Method, URL, headers, body, params, send, tabs
- [Response Viewer](specs/response-viewer/spec.md) — Status badge, body display, headers, timing waterfall, actions, states
- [Collection Management](specs/collection-management/spec.md) — Tree view, CRUD, YAML schema, drag-drop, folders, file watcher
- [Environment Variables](specs/environment-variables/spec.md) — Scope hierarchy, storage, interpolation, CRUD UI, switcher, masking
- [Webview Communication](specs/webview-communication/spec.md) — Protocol, errors, state sync, timeouts, serialization, handshake

## Constraints (Cross-Cutting)

- **Performance**: Extension activation < 100ms. Webview first paint < 500ms. HTTP request overhead < 5ms beyond network time.
- **Size**: Webview bundle < 500KB gzipped. Extension host bundle < 200KB.
- **Compatibility**: VS Code >= 1.85, Node.js >= 18, works on Windows/macOS/Linux.
- **Theme**: All UI MUST use `var(--vscode-*)` CSS variables. MUST pass visual check on: Default Dark+, Default Light+, High Contrast.
