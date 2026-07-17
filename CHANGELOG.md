# Changelog

All notable changes to **Volt** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> **Note**: Versions prior to **0.7.0** predate this changelog file.
> Historical `.vsix` artifacts shipped from **0.1.0** through **0.6.0** remain
> available at the project root for reference.

---

## [0.8.4] - 2026-07-17

### Fixed
- **Auto-update actually fires on startup** — added `onStartupFinished`
  to `activationEvents` so `activate()` runs on every VS Code startup,
  regardless of whether the workspace contains `.volt/collection.yaml`
  or the Volt sidebar is open. Previously, sideloaded installations
  on workspaces without a collection never triggered the update check.
- **Periodic re-checks while VS Code is open** — `UpdateService` now
  re-queries GitHub Releases every 6 hours via `setInterval`, so a
  release published during a long session is detected without a
  restart. The interval is cleared on extension teardown.
- **No more re-prompts for the same release** — the last notified
  version is persisted in `context.globalState`; the toast is shown
  once per release, not on every restart.
- **Update errors are no longer silent** — network failures, rate
  limits, and malformed API payloads now log to `Output → Volt` with
  full stack instead of being swallowed.

### Added
- **Manual command `Volt: Check for Updates`** — registered as
  `volt.checkForUpdates`. Bypasses the "already notified" suppression
  via `{ force: true }` so users can re-trigger the prompt on demand.
- **Tests for `parseReleaseInfo` and `isNewerVersion`** — 20 unit
  tests in `src/extension/services/update-service.test.ts`. Pure
  helpers extracted to `release-utils.ts` so they can be tested
  without the VS Code runtime.

### Internal
- Pure helpers (`parseReleaseInfo`, `isNewerVersion`) extracted from
  `update-service.ts` into `release-utils.ts` to keep `vscode`
  dependencies out of the unit-test surface.

---

## [0.8.3] - 2026-07-17

### Fixed
- **Auto-update reliability** — bumped package version so existing
  installations on **0.8.x** can detect a newer release through the
  GitHub Releases startup check. No behavioural changes.

---

## [0.8.0] - 2026-07-16

### Added
- **Body type round-trip conversion** — switch between `None`, `JSON`,
  `Text`, `Form Data` and `GraphQL` without losing payload content.
- **Unsaved-changes indicator** — panel title shows `●` when the active
  request has pending edits; closing with pending changes prompts first.
- **Enhanced response search** — case toggle (`Aa`), navigate matches
  with `Enter` / `Shift+Enter`, match counter, header filtering, and a
  dedicated search button in the response tabs bar.
- **Per-request Notes tab** — Markdown editor + preview with `Edited`
  relative-time and autosave.
- **Workspace-aware sidebar** — toolbar buttons only render when a
  folder is open.
- **Improved error feedback** — failed commands surface a notification
  and a structured `Output → Volt` line.
- **New host ↔ webview protocol messages** — `webview:set-dirty` and
  `event:new-request`.
- **PnP bypass plugin for esbuild** — fixes dependency resolution when
  a stale `.pnp.cjs` is found in an ancestor directory.

---

## [0.7.0] - 2026-07-01

### Added
- **Request Notes** — new dedicated "Notes" tab in the request builder,
  backed by a persistent `notes` field on each request.
  - Markdown editor with **Edit / Preview** mode toggle.
  - GitHub-Flavored Markdown rendering via `marked`, sanitized via
    `DOMPurify` (XSS-safe).
  - Side-by-side edit + preview layout with live relative-time helper
    ("Edited 2 min ago") backed by a `notesUpdatedAt` ISO timestamp.
  - Notes persist to the per-project `.volt/` collection YAML alongside
    the rest of the request metadata.

### Changed
- Request schema (`src/shared/schemas.ts`, `src/shared/models.ts`) now
  declares `notes` + `notesUpdatedAt` as first-class fields.
  Collection load/save round-trips them through `collection-service.ts`.

### Backwards Compatibility
- Existing collections using the legacy `description` field on a request
  continue to load — the loader transparently maps `description → notes`
  on read and writes the modern key back on save.

### Security
- Markdown rendering is constrained by the webview **CSP** (`https:`
  for remote resources) so external images/scripts injected via Notes
  cannot break out of the sandbox.

---

## Earlier Releases

Refer to the versioned `.vsix` artifacts at the project root:
`volt-0.1.0.vsix` … `volt-0.6.0.vsix`. Detailed per-release notes were
not tracked before **0.7.0**.
