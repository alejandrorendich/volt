# Request Builder Specification

## Purpose

Webview UI for composing HTTP requests: method, URL, headers, body, query params, with variable highlighting.

## Requirements

### Requirement: REQ-RB-001 — Method Selector

The builder MUST provide a dropdown with methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS. Default MUST be GET.

#### Scenario: Method selection

- GIVEN the request builder is open
- WHEN user selects POST from the method dropdown
- THEN the method updates to POST and body editor becomes visible

### Requirement: REQ-RB-002 — URL Input with Variable Highlighting

The URL input MUST accept free-text URLs. Variables in `{{var}}` syntax MUST be visually highlighted (distinct color). The input MUST support paste of full URLs with query params auto-parsed.

#### Scenario: Variable highlighting

- GIVEN the URL input contains `https://{{host}}/api/users`
- WHEN rendered
- THEN `{{host}}` displays with a distinct highlight color

#### Scenario: Paste URL with query params

- GIVEN an empty URL input
- WHEN user pastes `https://api.example.com/users?page=1&limit=10`
- THEN URL field shows `https://api.example.com/users`
- AND query params table auto-populates with `page=1` and `limit=10`

### Requirement: REQ-RB-003 — Headers Editor

The builder MUST provide a key-value table for headers. Each row MUST have: enabled toggle, key input, value input, delete button. Common headers SHOULD offer autocomplete.

#### Scenario: Add a header

- GIVEN the headers editor is empty
- WHEN user types `Authorization` in key and `Bearer token123` in value
- THEN a new header row is created and included in the request

#### Scenario: Disable a header

- GIVEN a header row with enabled toggle ON
- WHEN user toggles it OFF
- THEN the header is excluded from execution but remains visible (greyed out)

### Requirement: REQ-RB-004 — Body Editor

The builder MUST support body modes: none, raw (text), JSON, form-data, binary. JSON mode SHOULD validate syntax. Binary mode MUST allow file selection. Body MUST be disabled for GET/HEAD methods.

#### Scenario: JSON body validation

- GIVEN body mode is JSON and content is `{invalid`
- WHEN user focuses away from body editor
- THEN a validation warning appears indicating invalid JSON

#### Scenario: Body disabled for GET

- GIVEN the method is GET
- WHEN user views the body tab
- THEN the editor is disabled with a message "Body not available for GET requests"

### Requirement: REQ-RB-005 — Query Params Editor

The builder MUST provide a key-value table for query parameters, synced bidirectionally with the URL. Adding params MUST update the URL; editing URL params MUST update the table.

#### Scenario: Bidirectional sync

- GIVEN URL is `https://api.com/users`
- WHEN user adds param `page=2` in the table
- THEN URL updates to `https://api.com/users?page=2`

### Requirement: REQ-RB-006 — Send Button

The builder MUST have a prominent Send button. During execution, it MUST transform into a Cancel button. The button MUST be disabled when URL is empty.

#### Scenario: Send transforms to Cancel

- GIVEN a valid request is configured
- WHEN user clicks Send
- THEN the button changes to Cancel with a loading indicator
- AND clicking Cancel aborts the request

### Requirement: REQ-RB-007 — Request Tabs

The builder SHOULD support multiple open request tabs. Active tab MUST be visually distinct. Unsaved changes MUST show a dot indicator.

#### Scenario: Multiple tabs

- GIVEN two requests are open in tabs
- WHEN user switches to the second tab
- THEN the builder loads that request's configuration
