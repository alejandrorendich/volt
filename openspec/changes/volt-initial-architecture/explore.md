# Exploration: Volt — Initial Architecture

> **Change**: `volt-initial-architecture`
> **Phase**: explore
> **Date**: 2026-06-10
> **Project**: janoclient (Volt VS Code Extension)

---

## Current State

This is a **greenfield project**. The working directory (`C:\Users\Ale\Documents\JanoClient`) contains only the SDD scaffolding (`openspec/`, `.atl/`). There is no `package.json`, no `src/`, no `tsconfig.json`, no installed dependencies. Every architectural decision is open.

The `openspec/config.yaml` establishes the target:
- Platform: VS Code extension (TypeScript, Node.js)
- UI: VS Code Webview API
- Persistence: file-based collections on disk
- No response caching (always-live requests)
- Pre/post request scripts

---

## Affected Areas

Since this is greenfield, these are the files/directories that WILL need to exist:

- `src/extension.ts` — extension host entry point (activation, commands, file watchers)
- `src/webview/` — webview UI bundle (React/Svelte/Solid compiled output)
- `src/core/` — HTTP engine, collection manager, environment resolver, script runner
- `src/collections/` — file-format reader/writer, schema validator
- `src/scripts/` — pre/post script sandbox
- `package.json` — extension manifest + dependencies
- `tsconfig.json` — TypeScript config (two: one for extension host, one for webview)
- `vite.config.ts` or `webpack.config.js` — webview bundler config
- `.volt/` — runtime: active env state, ephemeral non-committed vars

---

## Area 1: Webview UI Framework

### Options Compared

| Framework | Min Bundle (gzip) | DX | Complex UI Support | VS Code Theme Integration | Notes |
|---|---|---|---|---|---|
| **React 18 + Vite** | ~42 KB | Excellent — massive ecosystem | Best: react-split, monaco-editor, tanstack | Via CSS vars `--vscode-*` | Most familiar, most component libraries |
| **Svelte 5** | ~7 KB | Excellent — compile-time, no VDOM | Good — growing ecosystem | Via CSS vars | Smallest bundle, runes = fine-grained reactivity |
| **Solid.js** | ~7 KB | Good — React-like syntax | Adequate — smaller ecosystem | Via CSS vars | Fastest DOM updates, but smaller ecosystem than React |
| **Lit (Web Components)** | ~16 KB | Fair — verbose, less ergonomic | Poor for complex apps | Via CSS vars (manual) | Good for isolated widgets, not ideal for app-shell |

### Key Constraints for VS Code Webview

1. **Bundle size matters but not critically**: Webview is loaded once per session and cached in memory. A 50 KB vs 200 KB difference is < 100ms on any modern machine. The real cost is **parse time**, not download.
2. **VS Code theme system**: All frameworks can use `var(--vscode-editor-foreground)` etc. No advantage for any framework here.
3. **Complex UI requirements**: Volt needs split panels, a tree view for collections, a JSON editor (Monaco or CodeMirror), tab management, response viewers. React's ecosystem is unmatched here.
4. **Monaco Editor**: The best in-extension code editor is Monaco. Its React wrapper (`@monaco-editor/react`) is mature. Svelte/Solid wrappers exist but are less battle-tested.
5. **Real precedent**: Thunder Client uses React. VS Code itself is React-based (partially). The VS Code webview samples all use vanilla JS or React.

### Recommendation: **React 18 + Vite**

**Why React over Svelte/Solid**: The productivity advantage of Svelte's smaller bundle (≈35 KB saved) does not outweigh the ecosystem advantage of React for a complex multi-panel app with Monaco, tree views, and split-pane layouts. The bundle will be served from the extension host's local filesystem — there is no network latency. React's ecosystem for complex UI (react-ariakit, react-split-pane, Tanstack Virtual for large response bodies) is the decisive factor.

**Why Vite over webpack**: Vite's build output for webviews is cleaner, faster HMR during development, and better tree-shaking. The Webview HMR approach requires a small shim but is well-documented.

**State management**: Zustand (2.9 KB gzipped) — not Redux, not Context-only. Zustand's simplicity matches the UI complexity without the Redux boilerplate tax.

---

## Area 2: HTTP Engine

### Options Compared

| Library | Streaming | WebSocket | SSE | GraphQL | Cert Handling | Proxy | Cancellation | Notes |
|---|---|---|---|---|---|---|---|---|
| **Node.js native `fetch`** | ✅ (body stream) | ❌ | ✅ (EventSource) | ✅ | ❌ native | Via env vars | ✅ AbortController | Available in Node 18+. No custom cert support natively. |
| **undici** | ✅ full | ❌ | ✅ | ✅ | ✅ agent | ✅ ProxyAgent | ✅ AbortController | Node.js HTTP/1.1 + HTTP/2. Powers native fetch. Lower-level control. |
| **got** | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | High-level, great DX, lots of plugins. `got-scraping` handles TLS fingerprinting. |
| **axios** | Limited | ❌ | ❌ native | ✅ | ✅ | ✅ | ✅ CancelToken | Widely known but showing its age; no ESM-native; streams are clunky. |

**WebSocket**: None of the above are WebSocket clients. Use `ws` (npm package) for WebSocket support separately. This is the correct separation of concerns.

**SSE**: Native `EventSource` does not support custom headers. Must implement SSE parsing manually over a streaming `fetch`/`undici` response.

### Recommendation: **undici** as the primary HTTP engine

**Why undici over native fetch**: `undici` is what Node.js `fetch` is built on, but exposes lower-level control. We need: custom certificates per-request, proxy support with auth, explicit timeout control at the socket level, HTTP/2 support, raw response stream access for large body visualization, and `MockAgent` for future testing. Native `fetch` cannot do client certificates natively. `undici` can via `Agent` with `connect.cert/key/ca`.

**Why undici over got**: `got` is excellent DX but is a high-level abstraction that hides what we need to expose (exact response timing, raw headers, redirect chain). `undici` gives us lower-level access with good TypeScript types.

**Protocol matrix**:
- HTTP/HTTPS: `undici` (`fetch` API or `request` API)
- WebSocket: `ws` package
- SSE: manual streaming over `undici` response body ReadableStream
- GraphQL: HTTP POST with `Content-Type: application/graphql` (no special lib needed; GraphQL is just HTTP)
- gRPC: `@grpc/grpc-js` (separate, optional module)

**Cancellation**: `AbortController` — supported by `undici`. Store one controller per active request, cancel on user action or tab close.

**Streaming responses**: Pipe `undici` response body as `ReadableStream` → send chunks to webview via `postMessage`. Never buffer the full response in the extension host if body > configurable threshold (default 10 MB).

---

## Area 3: Collection File Format

### What Competitors Do

| Tool | Format | Git-diff friendly | Human readable | Schema | Notes |
|---|---|---|---|---|---|
| **Postman** | JSON (`.json`) | Poor — one giant blob | Poor — minified | OpenAPI partial | Stored in cloud by default. Local export is one huge JSON. |
| **Thunder Client** | JSON (`.json` per collection) | Moderate | Moderate | Yes | Stored in `globalStorage` by default (hidden). Git sync optional. |
| **Insomnia** | JSON + YAML (`.yaml`) | Moderate | Good | Yes | Transitioning to git-native. |
| **Bruno** | Custom `.bru` DSL + new OpenCollection YAML | Good (`.bru`) / Excellent (YAML) | Excellent | Yes (YAML schema) | Bruno invented its own DSL, then pivoted to standard YAML. YAML is now recommended. |
| **Hoppscotch** | JSON | Poor | Poor | No | Cloud-first. |

### Bruno's OpenCollection YAML (2025 pivot)

Bruno now recommends YAML over its custom `.bru` DSL. The YAML format is:
```yaml
# collection.yaml
name: My API
version: 1
requests:
  - name: Get Users
    method: GET
    url: "{{base_url}}/users"
    headers:
      Authorization: "Bearer {{token}}"
    tests:
      - name: Status is 200
        assert: res.status == 200
```

This is the right direction. Industry-standard format, human-readable, excellent git-diff properties.

### Format Analysis

| Criterion | JSON | YAML | `.bru` DSL | Custom binary |
|---|---|---|---|---|
| Git-diff | ❌ Poor (inline, no blank lines) | ✅ Excellent (line-per-field, comments) | ✅ Good | ❌ No |
| Human readable | ❌ Noisy | ✅ Clean | ✅ Clean | ❌ No |
| Comments support | ❌ No | ✅ Yes | ✅ Yes | N/A |
| Tooling/schema validation | ✅ JSON Schema | ✅ JSON Schema + ajv | Custom | N/A |
| Merge conflict resolution | ❌ Hard | ✅ Easy | ✅ Easy | ❌ Impossible |
| Familiar to developers | ✅ Universal | ✅ Universal | ❌ Learn new DSL | ❌ No |

### Recommendation: **YAML with strict JSON Schema validation**

**Format**: One YAML file per request, directory structure mirrors collection hierarchy:

```
my-project/
  .volt/
    collection.yaml          # collection metadata
    environments/
      local.yaml
      staging.yaml            # committed
      .secrets.local.yaml     # gitignored
    requests/
      users/
        get-users.yaml
        create-user.yaml
      auth/
        login.yaml
```

**Why one file per request**: This is Bruno's breakthrough insight. One request = one file = one git-diff line when you change a URL. Atomic, reviewable, mergeable.

**Schema**: Define a JSON Schema (`volt-request.schema.json`) validated on load via `ajv`. VS Code YAML extension picks this up automatically for IntelliSense.

**Secret handling**: Separate `environments/.secrets.local.yaml` (gitignored by default via `.volt/.gitignore` that Volt writes on first use). The committed `staging.yaml` environment file contains variable NAMES but not values. Values come from secrets file or system env vars.

---

## Area 4: Scripting Engine

### The Problem

vm2 is **deprecated** (CVE vulnerabilities, unmaintained as of 2023). The Node.js built-in `vm` module is **not a sandbox** — it explicitly warns that it cannot be used to run untrusted code securely.

### Options Compared

| Solution | Isolation | Performance | API surface | Async support | Maintenance |
|---|---|---|---|---|---|
| **Node.js `vm`** | ❌ NONE — same V8 heap | ✅ Fast | ✅ Full Node | ✅ | ✅ Core |
| **isolated-vm** | ✅ True V8 Isolate | ✅ Fast (native) | ❌ Manual bridge | ✅ Callbacks | ⚠️ Maintenance mode, needs compiler |
| **quickjs-emscripten** | ✅ WASM sandbox | ✅ Good (WASM) | ❌ Manual bridge | ✅ Asyncify | ✅ Active (705K weekly downloads) |
| **Worker threads** | ✅ Separate heap | ✅ Good | ✅ Can pass modules | ✅ | ✅ Core Node |
| **Child process** | ✅ Full isolation | ⚠️ IPC overhead | ✅ Full Node | ✅ | ✅ Core Node |

### The Honest Threat Model

Volt's users are **developers writing their own pre/post scripts** for their own APIs. This is not arbitrary untrusted third-party code. The threat model is:
1. **Accidental infinite loops** → timeout protection needed
2. **Accidental memory leaks** → memory limit needed
3. **Deliberate malicious scripts from shared collections** → rare but possible (team collections)

For threat level 1+2, `worker_threads` is sufficient. For threat level 3, `quickjs-emscripten` is the right balance of security + DX.

### Recommendation: **`quickjs-emscripten` for scripting sandbox**

**Why quickjs-emscripten over isolated-vm**: `isolated-vm` is in maintenance mode and requires a native compiler (node-gyp) which breaks on many CI/CD environments and causes VS Code extension packaging nightmares. `quickjs-emscripten` is pure WASM — no native compilation, works everywhere Node.js works, 705K weekly downloads, actively maintained.

**Why quickjs-emscripten over worker_threads**: Worker threads share the same Node.js module graph — a script in a worker can `require` any module available in the extension host. `quickjs-emscripten` runs in a true WASM sandbox with no access to Node.js APIs unless explicitly exposed.

**Script API surface (modeled after Postman's `pm.*`):**

```typescript
// Exposed to user scripts via quickjs-emscripten bridge
const volt = {
  request: {
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    setHeader(key: string, value: string): void,
    setUrl(url: string): void,
  },
  response: {     // only in post-request scripts
    status: number,
    statusText: string,
    headers: Record<string, string>,
    body: string,
    json(): unknown,
    time: number,
  },
  env: {
    get(key: string): string | undefined,
    set(key: string, value: string): void,  // sets runtime var (not persisted)
  },
  test(name: string, fn: () => void): void,
  expect(value: unknown): ChaiAssertions,
}
```

**TypeScript in scripts**: The sandbox runs JavaScript. For TS support, strip types with a lightweight transform (esbuild `transform` API, ~300ms) before passing to the sandbox. User sees TS in the editor; sandbox runs JS.

---

## Area 5: Environment / Variable System

### Scoping Design (4 levels)

```
Global (workspace-wide, ~/.volt/global.yaml)
  └── Project (collection root, .volt/environments/*)
        └── Collection (inherited from project env)
              └── Request (inline overrides in request YAML)
```

Resolution order: **Request → Collection → Project → Global**. Later overrides earlier (most specific wins).

### Variable Interpolation Syntax

| Syntax | Used by | Pros | Cons |
|---|---|---|---|
| `{{var}}` | Postman, Bruno, Insomnia, Thunder Client | Universal in API tooling | Conflicts with some template engines |
| `${var}` | Shell, JS template literals | Developer-familiar | Conflicts with JS string interpolation |
| `<var>` | Some tools | Clean | Conflicts with HTML |
| `$var` | Shell | Short | Ambiguous in URLs |

**Recommendation: `{{var}}`** — the de-facto standard for API client variable syntax. Every developer who has used Postman/Bruno/Insomnia knows it. Do not invent a new syntax.

### Secret Handling Architecture

```
.volt/
  environments/
    staging.yaml          # committed — contains var NAMES and non-secret defaults
    .secrets.local.yaml   # gitignored — contains secret VALUES
    .gitignore            # auto-written by Volt: *.local.yaml, .secrets.*
```

Secret values are:
1. Never displayed in full in the UI (masked after 3 chars: `sk-proj-abc•••`)
2. Never included in exported collections
3. Never sent in telemetry
4. Never cached in VS Code global storage — only in the file on disk

### Dynamic Variables

Built-in `$dynamic` namespace (Postman-compatible where possible):

```yaml
headers:
  X-Request-Id: "{{$guid}}"        # random UUID v4
  X-Timestamp: "{{$timestamp}}"    # Unix timestamp
  X-Date: "{{$isoTimestamp}}"      # ISO 8601
  X-Random: "{{$randomInt}}"       # random integer 0-1000
  Authorization: "Bearer {{token}}" # user-defined env var
```

---

## Area 6: Competitive Differentiators

### What's Paywalled in Thunder Client

Based on docs research (thunder client has a license/subscription system):
- **Git Sync** for team collaboration requires paid license
- **Encrypted environments** (secret management) is paid
- **Secret Managers** (AWS Secrets Manager, Azure Key Vault) are paid
- **Advanced CLI** features are paid
- **Team collaboration** features are paid

**Volt's opportunity**: All of the above are FREE in Volt. Git sync is the default (file-based). Encrypted environments via gitignored local files, no cloud required.

### What Frustrates Postman Users (documented complaints)

1. **Response caching bug**: Postman has a known issue where it sometimes shows a cached response, not the actual live response. Volt's `no_response_cache: true` is a direct response to this.
2. **Requires account / cloud sync**: Volt is 100% offline, no account needed.
3. **Bloated UI**: Postman is slow to start, heavy UI. Volt targets snappy startup via lazy activation.
4. **Paywalled team features**: Volt is fully free.
5. **No true git-native collections**: Postman's JSON export is not git-friendly. Volt's YAML-per-file format is.
6. **Inline scripts are not type-safe**: Volt will offer TypeScript-stripped scripts.

### What Bruno Does Right

- File-based collections (the single best decision in modern API clients)
- Git-first collaboration
- Offline-only commitment
- No cloud sync ever (clear manifesto)

**What Bruno gets wrong / misses**:
- Bruno is a standalone Electron app — requires a separate window from VS Code
- Bruno's Electron overhead (~150MB RAM baseline) vs. Volt's webview (~20MB)
- Bruno's UI is functional but not premium (rough edges in layout, theming)
- Bruno has some paid features too (secret managers, SAML SSO)

### What's Missing from ALL of Them

1. **Request diffing**: "Show me what changed between this request and my last successful one." None do this.
2. **Response timeline visualization**: A Gantt-style view of DNS → TCP → TLS → TTFB → body transfer timing (like Chrome DevTools Network tab). None have this.
3. **Smart variable inference**: "I see `access_token` in this response body — do you want to store it as an environment variable?" None proactively suggest this.
4. **Inline schema validation against OpenAPI spec**: "This response doesn't match your OpenAPI spec for `GET /users`." None do this inside the client itself.
5. **Request chaining visualization**: A flowchart showing "request A → extracts token → passes to request B." Only Postman has a limited version, paywalled.
6. **AI-assisted script generation**: "Write a post-request script that extracts the JWT and saves it as `{{token}}`." None have this deeply integrated.
7. **Native WebSocket testing with message history**: Most tools have basic WS support; none visualize the full bidirectional message timeline well.

**Volt's killer differentiator recommendation**: The **response timeline visualization** (DNS/TCP/TLS/TTFB/Body timing) — this is what developers actually need when debugging slow APIs, and zero API clients show it natively. `undici` exposes timing via `Diagnostics_channel` which gives us all timing phases precisely.

---

## Area 7: Extension Architecture

### Activation Strategy

**Lazy activation** (critical for performance — VS Code penalizes heavy extensions):

```json
// package.json
"activationEvents": [
  "onCommand:volt.openClient",
  "onView:volt.collectionsTree",
  "workspaceContains:.volt/collection.yaml"
]
```

The extension activates ONLY when:
1. User explicitly runs `Volt: Open` command
2. User opens the Volt sidebar view
3. VS Code opens a workspace that contains a `.volt/collection.yaml` file

This means Volt has zero startup cost for users who don't use it in a given session.

### Communication Architecture (Extension Host ↔ Webview)

VS Code webviews communicate via `postMessage` (structured clone). This is the ONLY bridge — no shared memory.

```
Extension Host (Node.js)                    Webview (React)
─────────────────────────────────────────────────────────────
                    Message Types:

WV→EH: SEND_REQUEST { request, env }
EH→WV: RESPONSE_CHUNK { requestId, chunk, type }
EH→WV: RESPONSE_COMPLETE { requestId, timing, status }
EH→WV: RESPONSE_ERROR { requestId, error }

WV→EH: LOAD_COLLECTION { path }
EH→WV: COLLECTION_LOADED { tree }
EH→WV: COLLECTION_CHANGED { path, tree }   ← file watcher event

WV→EH: SAVE_REQUEST { path, data }
WV→EH: RUN_SCRIPT { type, code, context }
EH→WV: SCRIPT_RESULT { logs, envChanges, testResults }

WV→EH: GET_ENVS { }
EH→WV: ENVS_LOADED { envs, active }
```

**Typed message protocol**: Define a discriminated union `VoltMessage` type shared between extension host and webview via a `shared/messages.ts` file (imported by both TypeScript contexts).

### File Watchers

```typescript
// Collection sync
const watcher = vscode.workspace.createFileSystemWatcher(
  '**/.volt/**/*.yaml',
  false, // onCreate
  false, // onChange
  false  // onDelete
);

watcher.onDidChange(uri => collectionManager.reload(uri));
watcher.onDidCreate(uri => collectionManager.add(uri));
watcher.onDidDelete(uri => collectionManager.remove(uri));
```

File changes on disk (e.g., from git pull) propagate to the UI within milliseconds.

### State Management Approach

**Two separate state domains**:

1. **Extension Host state** (in-memory, Node.js): Active requests map, file system cache, environment resolver state, script runner instances. Managed with plain TypeScript classes (no framework).

2. **Webview state** (React + Zustand): UI state (active tab, selected request, editor content, response viewer state). Persisted across hide/show via `vscode.setState/getState`. Restored on VS Code restart via `WebviewPanelSerializer`.

### Two TypeScript Configs

```
tsconfig.extension.json  → target: node, module: commonjs (for extension host)
tsconfig.webview.json    → target: esnext, module: esnext (for Vite/React bundle)
```

This is essential — the extension host and webview are two different JavaScript environments.

---

## Recommended Stack Summary

| Layer | Choice | Rationale |
|---|---|---|
| Extension framework | VS Code Extension API (TypeScript) | Only option |
| Webview UI | React 18 + Vite | Best ecosystem for complex UI; Monaco integration |
| State management | Zustand | Minimal overhead, React-native DX |
| HTTP engine | undici | Low-level control, client certs, HTTP/2, timing |
| WebSocket | ws | Battle-tested, minimal |
| Collection format | YAML (one file per request) | Best git-diff, human-readable, standard tooling |
| Schema validation | ajv + JSON Schema | Fast, TypeScript types from schema |
| Scripting sandbox | quickjs-emscripten | Pure WASM, no native compilation, secure isolation |
| Script TypeScript support | esbuild transform API | Fast (~300ms), no full TS compiler needed |
| Variable interpolation | `{{var}}` | Industry standard, familiar |
| Secret management | gitignored local YAML | No cloud, no account, no paywall |

---

## Risks

1. **quickjs-emscripten WASM size**: The sync WASM bundle is ~500 KB, async ~1 MB. This adds to extension install size. Mitigation: lazy-load the WASM module only when a scripted request is first run (not on extension activation).

2. **undici version coupling**: undici major versions sometimes have breaking changes. Pin to a specific range and monitor Node.js updates (undici is bundled with Node.js but Volt will install its own for control).

3. **Monaco Editor bundle size**: `@monaco-editor/react` + Monaco itself is ~1.5 MB gzipped. This is unavoidable for a proper code editor. Mitigation: lazy-load Monaco only when the user opens a scripting tab or JSON body editor.

4. **VS Code theme compliance**: VS Code has 100+ themes. While `var(--vscode-*)` CSS variables cover 95% of cases, some custom themes may have unexpected values. Mitigation: test with default Light, Dark, High Contrast, and 3 popular marketplace themes.

5. **File watcher performance on large workspaces**: Glob pattern `**/.volt/**/*.yaml` could match many files in monorepos. Mitigation: scope watchers to workspace-configured collection roots only.

6. **YAML parsing security**: `js-yaml`'s `load()` (allowing arbitrary JS) must NEVER be used — use `safeLoad()` (YAML 1.1) or the default safe-by-default `load()` from `js-yaml` v4+ (which removed the unsafe loader). Always validate against JSON Schema after parsing.

---

## Ready for Proposal

**Yes** — the exploration is complete. The stack is clearly defined, risks are identified and have mitigations, and the competitive landscape is well understood.

The next phase (sdd-propose) should define:
- The initial MVP feature set (what ships in v0.1.0)
- The rollout phases (HTTP requests first, then WebSocket/SSE, then scripting)
- The project structure and monorepo vs single package decision
- Build pipeline: esbuild for extension host, Vite for webview

---

## Appendix: Competitive Paywall Summary

| Feature | Postman (free tier) | Thunder Client (free) | Bruno (free) | **Volt** |
|---|---|---|---|---|
| Unlimited requests | ❌ (flow limits) | ✅ | ✅ | ✅ |
| Git sync | ❌ (cloud only) | ❌ (paid) | ✅ | ✅ |
| Environments | ✅ | ✅ | ✅ | ✅ |
| Secret managers | ❌ | ❌ (paid) | ❌ (paid) | ✅ (via gitignored files) |
| Team collaboration | ❌ (paid) | ❌ (paid) | ✅ (via git) | ✅ (via git) |
| Pre/post scripts | ✅ | ✅ | ✅ | ✅ |
| Response timing detail | ❌ | ❌ | ❌ | ✅ (DNS/TCP/TLS/TTFB) |
| No account required | ❌ | ✅ | ✅ | ✅ |
| Offline-only | ❌ | ✅ | ✅ | ✅ |
| Always-live responses | ❌ (cache bug) | ✅ | ✅ | ✅ |
