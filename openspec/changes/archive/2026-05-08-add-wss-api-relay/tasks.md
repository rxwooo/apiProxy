## 1. Project Setup

- [x] 1.1 Add runtime structure for local proxy, remote relay, and shared relay protocol modules
- [x] 1.2 Add configuration loading for local bind address, relay URL, relay credentials, upstream base URL, upstream API key, chunk size, timeouts, and size limits
- [x] 1.3 Add or update package scripts and dependencies needed for HTTP serving, WSS client/server support, and test execution

## 2. Shared Relay Protocol

- [x] 2.1 Define request, response, cancellation, error, and health-check relay message types
- [x] 2.2 Implement payload chunking with configurable maximum chunk size and stable request ids
- [x] 2.3 Implement SHA-256 digest calculation and request payload integrity validation
- [x] 2.4 Implement request reassembly state with ordering, duplicate detection, size limits, timeout cleanup, and terminal-state handling
- [x] 2.5 Add unit tests for chunk boundaries, digest mismatch, duplicate chunks, out-of-order chunks, oversized payloads, and concurrent request ids

## 3. Local Proxy

- [x] 3.1 Implement a local HTTP server bound to loopback by default
- [x] 3.2 Implement `POST /v1/chat/completions` forwarding through the relay protocol
- [x] 3.3 Implement `GET /v1/models` forwarding or configured upstream-compatible model listing
- [x] 3.4 Implement authenticated WSS client connection management with heartbeat and reconnect behavior
- [x] 3.5 Translate non-streaming relay responses into HTTP status, headers, and body for the agent
- [x] 3.6 Translate streaming relay responses into agent-compatible streaming HTTP responses with immediate flushing
- [x] 3.7 Propagate local HTTP aborts to the relay as request cancellation messages
- [x] 3.8 Return gateway-style errors when the relay is unavailable, times out, or returns relay-level failures

## 4. Remote Relay

- [x] 4.1 Implement WSS server authentication and session lifecycle handling
- [x] 4.2 Accept request metadata and chunk messages, then reassemble and validate complete requests
- [x] 4.3 Enforce max request size, max concurrent requests, chunk ordering, digest validation, and idle cleanup
- [x] 4.4 Forward validated requests to the configured upstream model API with remote-side provider authentication
- [x] 4.5 Relay upstream non-streaming responses back through response metadata and response chunks
- [x] 4.6 Relay upstream streaming responses as chunks as soon as bytes are available
- [x] 4.7 Abort upstream calls and release request state when cancellation messages arrive
- [x] 4.8 Preserve safe upstream error status and body information through the relay path
- [x] 4.9 Add remote-side model alias to upstream model id mapping before forwarding
- [x] 4.10 Map upstream response model ids back to client aliases for JSON and SSE responses

## 5. Security and Operations

- [x] 5.1 Redact relay credentials, provider credentials, authorization headers, request bodies, and response bodies from default logs
- [x] 5.2 Add structured metadata logs for connection events, request ids, status, durations, byte counts, and failure reasons
- [x] 5.3 Document environment variables and provide a safe local configuration example
- [x] 5.4 Add startup validation that rejects unsafe or incomplete production configuration

## 6. Verification

- [x] 6.1 Add integration tests with local proxy, remote relay, and mocked upstream for a request body larger than 10 KB
- [x] 6.2 Add integration tests for non-streaming chat completion responses
- [x] 6.3 Add integration tests for streaming chat completion responses and chunk flushing
- [x] 6.4 Add integration tests for cancellation, relay disconnect, upstream error, timeout, invalid auth, and digest mismatch
- [x] 6.5 Add manual validation steps showing how to point an agent at the local proxy base URL
- [x] 6.6 Add unit and integration tests for server-side model id mapping
- [x] 6.7 Add unit and integration tests for response-side model id mapping
