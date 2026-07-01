# Changelog

All notable changes to **Volt** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> **Note**: Versions prior to **0.7.0** predate this changelog file.
> Historical `.vsix` artifacts shipped from **0.1.0** through **0.6.0** remain
> available at the project root for reference.

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
