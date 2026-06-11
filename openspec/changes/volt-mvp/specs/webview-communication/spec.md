# Webview Communication Specification

## Purpose

Typed postMessage protocol between VS Code extension host and React webview with discriminated unions, error propagation, and state sync.

## Requirements

### Requirement: REQ-MSG-001 — Message Protocol Structure

All messages MUST be typed discriminated unions with a `type` field. Messages from webview to extension MUST use prefix `request:*`. Messages from extension to webview MUST use prefix `response:*` or `event:*`. Each message MUST include a `correlationId` (UUID) for request/response matching.

#### Scenario: Request-response correlation

- GIVEN the webview sends `{type: "request:send-http", correlationId: "abc-123", payload: {...}}`
- WHEN the extension processes and responds
- THEN the response is `{type: "response:send-http", correlationId: "abc-123", payload: {...}}`

#### Scenario: Type safety enforcement

- GIVEN a message with unknown `type` field
- WHEN received by either side
- THEN the message is logged as warning and ignored (no crash)

### Requirement: REQ-MSG-002 — Error Propagation

When a request fails in the extension host, the response MUST include `error: {code: string, message: string}`. Error codes MUST be enumerated constants. The webview MUST handle errors gracefully without crashing.

#### Scenario: Extension error propagated

- GIVEN a `request:send-http` that fails with DNS error
- WHEN the extension sends the response
- THEN it includes `error: {code: "HTTP_DNS_ERROR", message: "Could not resolve host"}`
- AND `payload` is null

#### Scenario: Unhandled extension error

- GIVEN an unexpected exception in the extension host handler
- WHEN the error is caught
- THEN a generic `{code: "INTERNAL_ERROR", message: "..."}` is sent back
- AND the error is logged to extension output channel

### Requirement: REQ-MSG-003 — State Synchronization

The extension MUST push state updates via `event:*` messages (not request-response). Events: `event:collection-changed`, `event:environment-changed`, `event:response-streaming`. The webview MUST NOT poll for state.

#### Scenario: Collection file changes externally

- GIVEN a YAML file is modified outside VS Code
- WHEN the file watcher detects the change
- THEN the extension sends `{type: "event:collection-changed", payload: {path, action}}`
- AND the webview updates its tree without user action

#### Scenario: Response streaming

- GIVEN a large response downloading
- WHEN chunks arrive from the HTTP engine
- THEN the extension sends `{type: "event:response-streaming", payload: {chunk, progress}}`
- AND the webview renders progressively

### Requirement: REQ-MSG-004 — Message Timeout

Request messages MUST timeout after 30 seconds (configurable). On timeout, the webview MUST show an error state and the pending promise MUST reject. Timeouts MUST NOT block subsequent requests.

#### Scenario: Request timeout

- GIVEN a `request:send-http` is sent
- WHEN 30 seconds pass without a response
- THEN the webview rejects the promise with a timeout error
- AND subsequent messages can still be sent/received

### Requirement: REQ-MSG-005 — Message Serialization

All message payloads MUST be JSON-serializable (no functions, no circular refs, no undefined values). Binary data (response bodies) MUST be encoded as base64 strings or transferred via a separate file-based mechanism for bodies > 5MB.

#### Scenario: Large binary response

- GIVEN a response body of 10MB
- WHEN the extension prepares the response message
- THEN the body is written to a temp file and the message payload contains `{bodyRef: "file:///tmp/volt-resp-xyz"}`

#### Scenario: Non-serializable payload rejected

- GIVEN code attempts to send a message with a circular reference
- WHEN serialization is attempted
- THEN the error is caught, logged, and an INTERNAL_ERROR response is sent

### Requirement: REQ-MSG-006 — Webview Ready Handshake

The webview MUST send a `request:ready` message after React mounts. The extension MUST NOT send any events until this handshake completes. Messages sent before ready MUST be queued and flushed after handshake.

#### Scenario: Extension queues events before ready

- GIVEN the webview is still loading (React not yet mounted)
- WHEN a file change event occurs
- THEN the extension queues the event
- AND after `request:ready` is received, all queued events are flushed in order
