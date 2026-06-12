# Volt

> Fast, free HTTP client for VS Code.

Volt is a VS Code extension that lets you design, execute, and save HTTP requests directly inside the editor — with zero subscriptions, zero telemetry, and file-based collections that version-control cleanly with your code.

## Features

### Request Builder

- All HTTP methods (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD)
- Headers editor with bulk edit mode
- Body: JSON, plain text, form-data, GraphQL
- Query parameters with key-value editor
- Variable interpolation with `{{var}}` syntax and live preview
- Pre-request and post-request scripts (async/await supported)

### Authentication

- Bearer Token
- Basic Auth
- API Key (header or query)
- OAuth 2.0 (with "Get Token" flow)
- AWS Signature V4

### Response Viewer

- Syntax-highlighted body (Pretty / Raw tabs)
- Headers table
- Timing waterfall with sparkline visualization
- Response notes

### Testing & Assertions

- GUI-based assertion rules (no code required)
- Subjects: status code, response time, JSON path, header value
- Operators: equals, not equals, contains, greater than, less than, exists
- Pass/fail indicators per assertion
- Collection Runner — execute all requests in a folder sequentially with delay support

### Real-Time Protocols

- WebSocket client with send/receive panel
- Server-Sent Events (SSE) streaming

### Code Generation

Generate runnable code from any request:
- cURL
- JavaScript (fetch)
- JavaScript (axios)
- Python (requests)
- Node.js (http)
- PHP (cURL)

### Collections & Organization

- YAML-based, one file per request, git-diffable
- Sidebar tree with folder navigation and inline actions
- Drag-and-drop reorder
- Duplicate, rename, delete requests and folders
- CRUD Scaffold — auto-generate GET/POST/PUT/DELETE requests for a resource
- Request history with full response bodies

### Import & Export

- Import from Postman (collections)
- Import from cURL (clipboard)
- Export individual requests or entire folders
- Copy any request as cURL

### Environments

- Scoped variable resolution
- `{{var}}` interpolation everywhere (URL, headers, body, auth fields)
- Environment switcher in the UI
- Pre/post scripts can read and write env variables at runtime

### Cookie Jar

- Automatic cookie capture from responses
- Cookies applied to subsequent requests
- Clear Cookie Jar command

### Other

- Configurable timeout, redirect following, SSL toggle
- Proxy support
- Auto-update check from GitHub Releases
- Keyboard shortcuts (`Ctrl+Alt+V` open panel, `Ctrl+Enter` send, `Ctrl+Alt+N` new request)
- Full VS Code theme sync

## Getting Started

1. Install from `.vsix` or VS Code Marketplace
2. Open any workspace
3. Run **Volt: Open Panel** (`Ctrl+Alt+V`) or **Volt: New Request** from the Command Palette
4. A `.volt/` directory is created automatically in your workspace root

## Collection Format

```
.volt/
  collection.yaml          # index + ordering
  requests/
    auth/
      login.yaml
    users/
      list-users.yaml
  envs/
    development.yaml
    production.yaml
```

## Tech Stack

- **Extension host**: TypeScript, esbuild
- **Webview UI**: React 18, Zustand, Vite
- **HTTP engine**: undici
- **Tests**: Vitest
- **Minimum VS Code**: 1.85.0

## Development

```bash
npm install
npm run dev          # watch extension + webview
npm run build        # production build
npm run test         # run tests
npm run package      # create .vsix
```

## License

MIT
