# Collection Management Specification

## Purpose

CRUD operations on requests and folders with YAML file persistence, tree view UI, and file watcher for external changes.

## Requirements

### Requirement: REQ-COL-001 — Tree View Display

The sidebar MUST display a hierarchical tree: Collection → Folders → Requests. Each node MUST show an icon (folder/method badge) and name. The tree MUST refresh when files change on disk.

#### Scenario: Tree renders collection

- GIVEN `.volt/collection.yaml` exists with 2 folders and 5 requests
- WHEN the sidebar tree loads
- THEN all folders and requests display in their hierarchy with correct icons

#### Scenario: External file change detected

- GIVEN a request YAML file is modified externally (git pull, editor)
- WHEN the file watcher detects the change
- THEN the tree refreshes to reflect updated state without user action

### Requirement: REQ-COL-002 — CRUD Operations

The system MUST support: create request, create folder, rename, duplicate, delete. Delete MUST prompt for confirmation. Create MUST generate a valid YAML file immediately.

#### Scenario: Create new request

- GIVEN user right-clicks a folder and selects "New Request"
- WHEN a name is provided
- THEN a YAML file is created at `.volt/requests/{folder}/{name}.yaml`
- AND the tree updates and the request opens in the builder

#### Scenario: Delete with confirmation

- GIVEN a request exists in the tree
- WHEN user selects "Delete"
- THEN a confirmation dialog appears
- AND on confirm, the YAML file is deleted from disk

### Requirement: REQ-COL-003 — YAML Schema

Each request MUST be stored as a YAML file conforming to a defined schema. Required fields: `method`, `url`. Optional: `headers`, `body`, `params`, `description`, `variables`.

#### Scenario: Valid request file

- GIVEN a file `.volt/requests/users/get-all.yaml` with content:
  ```yaml
  method: GET
  url: "{{baseUrl}}/users"
  headers:
    Authorization: "Bearer {{token}}"
  params:
    page: "1"
  ```
- WHEN the collection manager reads it
- THEN it parses successfully into a request model

#### Scenario: Invalid YAML file

- GIVEN a request file with missing `method` field
- WHEN the collection manager validates it
- THEN a validation error is surfaced in the UI (not a crash)

### Requirement: REQ-COL-004 — Drag and Drop Reorder

The tree view SHOULD support drag-and-drop to reorder requests within a folder and move requests between folders. The ordering MUST persist via a `.volt/collection.yaml` order array.

#### Scenario: Move request to another folder

- GIVEN request "get-users" is in folder "Users"
- WHEN user drags it to folder "Admin"
- THEN the YAML file moves to `.volt/requests/admin/get-users.yaml`
- AND the tree updates immediately

### Requirement: REQ-COL-005 — Folder Organization

Folders MUST map to filesystem directories under `.volt/requests/`. Nested folders SHOULD be supported up to 3 levels deep. Empty folders MUST persist (via `.keep` file or collection.yaml reference).

#### Scenario: Create nested folder

- GIVEN a folder "API" exists
- WHEN user creates subfolder "v2" inside "API"
- THEN directory `.volt/requests/api/v2/` is created
- AND the tree shows the nested structure

### Requirement: REQ-COL-006 — File Watcher Scope

The file watcher MUST monitor only the `.volt/` directory using `vscode.workspace.createFileSystemWatcher`. It MUST debounce rapid changes (100ms). It MUST NOT watch outside `.volt/`.

#### Scenario: Rapid file changes debounced

- GIVEN a git checkout modifies 20 files in `.volt/` within 50ms
- WHEN the watcher processes events
- THEN only ONE tree refresh occurs (debounced)
