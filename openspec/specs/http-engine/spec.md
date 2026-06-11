# HTTP Engine Specification

## Purpose

Execute HTTP requests via undici with per-phase timing, cancellation, redirect control, and structured error handling.

## Requirements

### Requirement: REQ-HTTP-001 — Request Execution

The engine MUST execute HTTP methods GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS. It MUST support arbitrary headers, request body (text, JSON, form-data, binary), and query parameters.

#### Scenario: Simple GET request

- GIVEN a valid URL `https://httpbin.org/get`
- WHEN the engine executes a GET request
- THEN a response is returned with status, headers, body, and timing

#### Scenario: POST with JSON body

- GIVEN a POST request with `Content-Type: application/json` and body `{"key":"value"}`
- WHEN the engine executes the request
- THEN the server receives the JSON payload intact

### Requirement: REQ-HTTP-002 — Timing Breakdown

The engine MUST capture per-phase timing via `diagnostics_channel`: DNS lookup, TCP connect, TLS handshake, time-to-first-byte (TTFB), and body download. All values MUST be in milliseconds.

#### Scenario: Timing data captured

- GIVEN a request to an HTTPS endpoint
- WHEN the response completes
- THEN timing object contains `dns`, `tcp`, `tls`, `ttfb`, `download` fields (all >= 0)

#### Scenario: HTTP (no TLS) timing

- GIVEN a request to an HTTP endpoint
- WHEN the response completes
- THEN `tls` is 0 and other timing fields are populated

### Requirement: REQ-HTTP-003 — Cancellation

The engine MUST support request cancellation via `AbortController`. Cancellation MUST terminate in-flight connections within 100ms.

#### Scenario: User cancels mid-request

- GIVEN a request is in progress
- WHEN the user triggers cancellation
- THEN the request aborts, returns an error with `type: 'cancelled'`
- AND no response data is emitted after cancellation

### Requirement: REQ-HTTP-004 — Redirect Handling

The engine MUST follow redirects by default (max 10). It SHOULD expose a `followRedirects: boolean` option. Redirect chain MUST be captured in the response metadata.

#### Scenario: Redirect chain captured

- GIVEN a URL that 301-redirects twice
- WHEN the engine executes the request
- THEN response includes `redirects: [{status, url}, ...]` array

### Requirement: REQ-HTTP-005 — Error Handling

The engine MUST return structured errors: `timeout`, `cancelled`, `dns_error`, `connection_refused`, `tls_error`, `network_error`. Errors MUST NOT throw unhandled exceptions.

#### Scenario: Connection timeout

- GIVEN a request with timeout 5000ms to an unreachable host
- WHEN 5000ms elapse without response
- THEN an error with `type: 'timeout'` is returned

#### Scenario: DNS resolution failure

- GIVEN a request to `https://nonexistent.invalid`
- WHEN DNS lookup fails
- THEN an error with `type: 'dns_error'` and descriptive message is returned

### Requirement: REQ-HTTP-006 — Response Size Limit

The engine MUST enforce a configurable response body limit (default: 50MB). Responses exceeding the limit MUST be truncated with a `truncated: true` flag.

#### Scenario: Oversized response

- GIVEN a response body exceeding 50MB
- WHEN the download reaches the limit
- THEN the body is truncated and `response.truncated` is `true`

### Requirement: REQ-HTTP-007 — TLS Certificate Handling

The engine SHOULD expose certificate info (issuer, expiry, subject). It MUST allow skipping TLS verification via a per-request `rejectUnauthorized: false` option.

#### Scenario: Self-signed certificate with verification disabled

- GIVEN a request to a server with a self-signed cert and `rejectUnauthorized: false`
- WHEN the engine executes
- THEN the request succeeds without TLS error
