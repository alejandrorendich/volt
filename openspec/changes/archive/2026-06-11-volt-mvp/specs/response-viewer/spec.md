# Response Viewer Specification

## Purpose

Display HTTP response: status badge, body with syntax highlighting, headers table, timing waterfall, and action buttons.

## Requirements

### Requirement: REQ-RV-001 — Status Badge

The viewer MUST display the status code with color coding: 2xx green, 3xx blue, 4xx orange, 5xx red. Status text (e.g., "OK") MUST appear beside the code. Response time (total ms) and size MUST display adjacent.

#### Scenario: Successful response

- GIVEN a 200 OK response of 1.2KB in 245ms
- WHEN the viewer renders
- THEN status shows green "200 OK", time shows "245 ms", size shows "1.2 KB"

#### Scenario: Server error

- GIVEN a 500 Internal Server Error
- WHEN the viewer renders
- THEN status shows red "500 Internal Server Error"

### Requirement: REQ-RV-002 — Response Body Display

The viewer MUST display the body with syntax highlighting based on Content-Type: JSON (collapsible tree + raw), XML, HTML, plain text. Binary responses MUST show a hex preview or download prompt. Body MUST be searchable (Ctrl+F).

#### Scenario: JSON response formatted

- GIVEN a response with `Content-Type: application/json`
- WHEN the viewer renders the body
- THEN JSON is pretty-printed with syntax highlighting and collapsible nodes

#### Scenario: Binary response

- GIVEN a response with `Content-Type: application/octet-stream`
- WHEN the viewer renders
- THEN a hex preview shows (first 1KB) with a "Save to file" button

#### Scenario: Large response (>1MB)

- GIVEN a JSON response body exceeding 1MB
- WHEN the viewer renders
- THEN only the first 1MB is rendered with a "Show more" or "Save full response" option

### Requirement: REQ-RV-003 — Headers Table

The viewer MUST display response headers in a sorted key-value table. Long values MUST be truncatable/expandable. Header count MUST show in tab label.

#### Scenario: Headers display

- GIVEN a response with 12 headers
- WHEN user clicks the Headers tab
- THEN all 12 headers display in alphabetical order with "Headers (12)" in the tab

### Requirement: REQ-RV-004 — Timing Waterfall

The viewer MUST display a horizontal bar chart showing: DNS, TCP, TLS, TTFB, Download phases. Each phase MUST show duration in ms on hover. Total time MUST display above the chart.

#### Scenario: HTTPS timing breakdown

- GIVEN timing `{dns: 15, tcp: 30, tls: 45, ttfb: 80, download: 20}`
- WHEN the waterfall renders
- THEN 5 colored bars display proportionally with total "190 ms" above

#### Scenario: HTTP (no TLS) timing

- GIVEN timing with `tls: 0`
- WHEN the waterfall renders
- THEN the TLS bar is omitted (not shown as empty space)

### Requirement: REQ-RV-005 — Copy and Save Actions

The viewer MUST provide: copy body to clipboard, copy as cURL, save body to file. Copy SHOULD use raw (unformatted) content.

#### Scenario: Copy body

- GIVEN a JSON response is displayed
- WHEN user clicks "Copy body"
- THEN the raw JSON string is placed on the clipboard

#### Scenario: Copy as cURL

- GIVEN a completed request/response
- WHEN user clicks "Copy as cURL"
- THEN a valid cURL command reproducing the request is copied

### Requirement: REQ-RV-006 — Empty and Error States

The viewer MUST display appropriate states: empty (no request sent yet), loading (request in flight), error (network failure with error type and message).

#### Scenario: No request sent

- GIVEN the viewer has no response data
- WHEN rendered
- THEN a placeholder message "Send a request to see the response" displays

#### Scenario: Network error display

- GIVEN a request that failed with `type: 'connection_refused'`
- WHEN the viewer renders
- THEN an error state shows with icon, error type, and actionable message
