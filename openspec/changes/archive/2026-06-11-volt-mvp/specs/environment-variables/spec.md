# Environment Variables Specification

## Purpose

Variable resolution with scoped hierarchy, `{{var}}` interpolation, CRUD UI, and environment switching.

## Requirements

### Requirement: REQ-ENV-001 — Scope Hierarchy

Variables MUST resolve in order: request → collection → project → global. The first match wins. Undefined variables MUST be left as literal `{{var}}` text (not empty string) and flagged as warnings.

#### Scenario: Request scope overrides project scope

- GIVEN project variable `baseUrl = https://prod.api.com`
- AND request variable `baseUrl = http://localhost:3000`
- WHEN `{{baseUrl}}` is interpolated
- THEN the value resolves to `http://localhost:3000`

#### Scenario: Undefined variable warning

- GIVEN no variable named `token` exists in any scope
- WHEN `{{token}}` is encountered during interpolation
- THEN the literal `{{token}}` remains in the output
- AND a warning is emitted listing unresolved variables

### Requirement: REQ-ENV-002 — Variable Storage

Project-level variables MUST be stored in `.volt/environments/{env-name}.yaml`. Request-level variables MUST be inline in the request YAML under a `variables` key. File format MUST be simple key-value YAML.

#### Scenario: Environment file structure

- GIVEN an environment named "development"
- WHEN stored on disk
- THEN the file `.volt/environments/development.yaml` contains:
  ```yaml
  baseUrl: http://localhost:3000
  token: dev-token-123
  ```

### Requirement: REQ-ENV-003 — Interpolation Engine

The engine MUST replace all `{{variableName}}` occurrences in: URL, headers (keys and values), body, and query params. Interpolation MUST be recursive (one pass only — no nested variable expansion). Variables MUST support alphanumeric characters, underscores, and hyphens.

#### Scenario: Interpolation in multiple fields

- GIVEN `baseUrl = https://api.com` and `token = abc123`
- WHEN a request has URL `{{baseUrl}}/users` and header `Authorization: Bearer {{token}}`
- THEN the executed URL is `https://api.com/users`
- AND the header value is `Bearer abc123`

#### Scenario: Invalid variable name ignored

- GIVEN text containing `{{invalid name with spaces}}`
- WHEN interpolation runs
- THEN the text is left unchanged (not treated as a variable reference)

### Requirement: REQ-ENV-004 — Variable CRUD UI

The webview MUST provide a variables panel with: add, edit, delete operations. Each variable row MUST show key, value (masked for sensitive), and scope badge. Inline editing MUST be supported.

#### Scenario: Add new variable

- GIVEN the variables panel is open
- WHEN user clicks "Add Variable" and enters key "apiKey" with value "sk-123"
- THEN the variable is persisted to the active environment file

### Requirement: REQ-ENV-005 — Environment Switcher

The UI MUST show a dropdown listing available environments (from `.volt/environments/*.yaml`). Switching MUST re-resolve all variables immediately. The active environment MUST persist in `.volt/config.yaml`.

#### Scenario: Switch environment

- GIVEN environments "development" and "production" exist
- WHEN user selects "production" from the switcher
- THEN all `{{var}}` references resolve against production values
- AND the active environment is saved to `.volt/config.yaml`

### Requirement: REQ-ENV-006 — Sensitive Variable Masking

Variables with keys matching patterns (`*secret*`, `*token*`, `*password*`, `*key*`) SHOULD be masked in the UI (show `•••••`). Values MUST be available for interpolation regardless of masking.

#### Scenario: Token masked in UI

- GIVEN a variable `apiToken = sk-live-abc123`
- WHEN displayed in the variables panel
- THEN the value shows as `•••••` with a reveal toggle
- AND interpolation still uses the actual value `sk-live-abc123`
