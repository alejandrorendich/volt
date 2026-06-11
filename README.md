# Volt

> Fast, free HTTP client for VS Code.

Volt is a VS Code extension that lets you design, execute, and save HTTP requests directly inside the editor — with zero subscriptions, zero telemetry, and file-based collections that version-control cleanly with your code.

## Features

- **Request Builder** — method, URL, headers, body (JSON/text/form-data), query params
- **Response Viewer** — syntax-highlighted body, headers table, timing waterfall
- **Collections** — YAML-based, one file per request, git-diffable
- **Environments** — scoped variable resolution, `{{var}}` interpolation
- **Sidebar Tree** — folder-based request navigation with drag-and-drop reorder

## Getting Started

1. Open any workspace
2. Run **Volt: New Request** (`Ctrl+Shift+P` → `Volt: New Request`)
3. A `.volt/` directory is created automatically in your workspace root

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

## License

MIT
