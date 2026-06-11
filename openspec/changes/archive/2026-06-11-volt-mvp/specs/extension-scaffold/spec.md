# Extension Scaffold Specification

## Purpose

VS Code extension lifecycle: activation, commands, sidebar panel, and webview management.

## Requirements

### Requirement: REQ-EXT-001 — Lazy Activation

The extension MUST activate only when `workspaceContains:.volt/collection.yaml` matches. It MUST NOT add activation cost to workspaces without `.volt/`.

#### Scenario: Workspace has .volt directory

- GIVEN a workspace containing `.volt/collection.yaml`
- WHEN VS Code starts
- THEN the extension activates and registers all commands

#### Scenario: Workspace lacks .volt directory

- GIVEN a workspace without `.volt/collection.yaml`
- WHEN VS Code starts
- THEN the extension does NOT activate
- AND zero CPU/memory is consumed by the extension

### Requirement: REQ-EXT-002 — Command Registration

The extension MUST register commands: `volt.newRequest`, `volt.openCollection`, `volt.sendRequest`, `volt.switchEnvironment`. Each MUST appear in the command palette when the extension is active.

#### Scenario: Command palette access

- GIVEN the extension is active
- WHEN the user opens the command palette and types "Volt"
- THEN all registered Volt commands are listed

### Requirement: REQ-EXT-003 — Webview Panel Lifecycle

The extension MUST create a webview panel using `vscode.window.createWebviewPanel`. The panel MUST retain state across visibility changes via `WebviewPanelSerializer`. Only ONE panel instance SHOULD exist at a time (singleton).

#### Scenario: Panel creation

- GIVEN no Volt panel is open
- WHEN user executes `volt.newRequest`
- THEN a webview panel opens in the active editor column

#### Scenario: Panel restoration after VS Code restart

- GIVEN a Volt panel was open when VS Code closed
- WHEN VS Code reopens the workspace
- THEN the panel restores its previous state via serializer

#### Scenario: Duplicate panel prevention

- GIVEN a Volt panel is already open
- WHEN user executes `volt.newRequest` again
- THEN the existing panel is focused (not duplicated)

### Requirement: REQ-EXT-004 — Sidebar Tree View

The extension MUST contribute a Tree View in the activity bar (`viewsContainers.activitybar`) displaying collections. The icon MUST use a bolt/lightning SVG.

#### Scenario: Sidebar visibility

- GIVEN the extension is active
- WHEN user clicks the Volt icon in the activity bar
- THEN the collections tree view is shown in the sidebar

### Requirement: REQ-EXT-005 — Content Security Policy

The webview MUST set a strict CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`. External resources MUST NOT be loadable.

#### Scenario: Inline script blocked

- GIVEN the webview is loaded
- WHEN malicious content attempts to inject an inline script
- THEN the browser blocks execution due to CSP nonce mismatch
