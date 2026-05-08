## Why

Some deployment environments restrict the maximum size of normal HTTP requests, which prevents agents from sending large prompts or tool context to third-party model APIs. WebSocket Secure traffic is not affected by the same request-size limit in the target environment, so the service needs a local API-compatible proxy that tunnels oversized requests through WSS to a remote relay.

## What Changes

- Add a local HTTP API proxy that agents can target with an OpenAI-compatible base URL.
- Add a WSS relay protocol that chunks local requests into bounded frames below the constrained network request limit.
- Add a remote relay service that reassembles request chunks, validates integrity, forwards requests to the configured third-party model API, and relays responses back over WSS.
- Support both non-streaming JSON responses and streaming responses compatible with agent clients.
- Add cancellation, timeout, authentication, size limits, and connection health behavior for the relay path.

## Capabilities

### New Capabilities

- `wss-api-relay`: End-to-end local API proxy and WSS relay behavior for chunked requests, upstream model API forwarding, and response delivery.

### Modified Capabilities

- None.

## Impact

- Adds local proxy runtime behavior for OpenAI-compatible endpoints such as chat completions and model listing.
- Adds remote relay runtime behavior for authenticated WSS sessions and upstream API forwarding.
- Adds shared request/response chunking protocol, integrity validation, and error handling.
- Adds configuration for local bind address, relay server URL, relay authentication, upstream provider URL, upstream API key, chunk size, limits, and timeouts.
- May introduce runtime dependencies for HTTP server handling, WSS client/server support, streaming response handling, and optional compression.
