## Context

Agents commonly expect an OpenAI-compatible HTTP API. In the target environment, direct outbound HTTP requests can fail when a single request exceeds 10 KB, while WSS traffic is available. The relay must therefore keep the agent integration local, move constrained network traffic onto WSS, and preserve enough streaming behavior that existing agent clients continue to work.

The change introduces two runtime roles:

```text
Agent
  | local HTTP
  v
Local Proxy
  | authenticated WSS, chunked frames
  v
Remote Relay
  | HTTPS
  v
Third-party model API
```

## Goals / Non-Goals

**Goals:**

- Let agents use a local OpenAI-compatible base URL without changing prompt or tool payload size behavior.
- Keep every WSS application data frame below the configured network-safe chunk size.
- Reassemble and validate complete requests on the remote relay before upstream forwarding.
- Support streaming and non-streaming responses.
- Support cancellation, timeout enforcement, request/response size limits, and authenticated relay sessions.
- Keep third-party provider API keys on the remote relay where possible.

**Non-Goals:**

- Bypassing third-party provider request limits, policy limits, billing rules, or terms of service.
- Durable resume of in-flight requests after WSS disconnects.
- Full provider abstraction across incompatible APIs in the first version.
- Exposing the local proxy outside loopback interfaces by default.

## Decisions

### Local proxy exposes an OpenAI-compatible HTTP surface

The local proxy will listen on `127.0.0.1` by default and expose the endpoints agents need, initially including chat completions and model listing. The proxy will preserve request paths, methods, headers relevant to content negotiation, and JSON bodies instead of inventing a new client API.

Alternative considered: require agents to integrate with a custom SDK. That would reduce compatibility and increase adoption cost, so the local HTTP surface is preferred.

### WSS is the only remote transport between local and server

The local proxy will maintain an authenticated WSS connection to the remote relay. Requests will be multiplexed by `requestId` so one connection can carry concurrent model calls.

Alternative considered: open one WSS connection per request. That is simpler, but adds handshake overhead and makes connection health and backpressure harder under agent workloads.

### Use explicit application-level chunking

Control messages will be JSON text frames. Payload chunks will use binary frames with a small envelope that identifies message type, request id, sequence number, and payload bytes. The default maximum application payload chunk size will be below 10 KB, with 8 KB as the recommended default to leave room for protocol overhead.

Request flow:

```text
request.start  -> metadata: method, path, headers, stream flag, encoding, total bytes
request.chunk  -> binary payload: requestId, seq, bytes
request.end    -> final metadata: chunk count, sha256
```

Response flow:

```text
response.start -> status, headers, stream flag
response.chunk -> response bytes
response.end   -> completion metadata
```

Cancellation flow:

```text
request.cancel -> requestId, reason
```

Alternative considered: rely on WebSocket fragmentation alone. That does not provide portable application-level integrity checks, replay detection, or clear per-request state, so explicit chunking is preferred.

### Validate integrity before upstream forwarding

The remote relay will buffer incoming request chunks by `requestId`, reject duplicate or out-of-order chunks, enforce configured limits, and validate a SHA-256 digest before calling the upstream API. Invalid or incomplete requests will produce a structured relay error and release buffered memory.

Alternative considered: stream request chunks directly into the upstream API. Most model API requests need complete JSON bodies, and digest validation is important for this network workaround, so the first version will reassemble before forwarding.

### Preserve streaming responses end to end

When the upstream API returns SSE or another streaming HTTP response, the remote relay will forward bytes as `response.chunk` messages as they arrive. The local proxy will translate the chunks back into an HTTP streaming response for the agent. Non-streaming responses can be relayed as one or more chunks with the original status code and content type.

Alternative considered: wait for the full upstream response before sending back to the local proxy. That is simpler but harms agent latency and can break clients expecting incremental tokens.

### Put provider credentials on the remote relay

The local proxy will authenticate to the relay using a relay token or equivalent credential. The remote relay will hold the upstream provider base URL and API key. This keeps third-party model API keys out of local agent configuration and lets the remote service enforce provider routing and limits centrally.

Alternative considered: forward the user's provider API key from the local proxy. That is flexible but leaks more sensitive material across local configuration and logs.

### Map model aliases on the remote relay

The remote relay will optionally apply a configured model id map before upstream forwarding. Clients can send a stable alias such as `A`, while the relay rewrites the top-level JSON `model` field to the provider-specific model id. When the upstream response includes the provider-specific model id, the relay rewrites response JSON and SSE data events back to the original client alias. Keeping this on the remote side avoids coupling local agent configuration to provider model names.

Alternative considered: perform model mapping in the local proxy. That would work, but it spreads provider routing knowledge into local deployments and makes central provider changes harder.

## Risks / Trade-offs

- Network middleboxes may still limit WSS frame size, total transfer size, or connection lifetime -> keep chunk size configurable, add ping/pong health checks, and surface clear diagnostics.
- Remote reassembly buffers can consume memory under large or concurrent requests -> enforce max request bytes, max concurrent requests, idle timeouts, and cleanup on error or disconnect.
- Streaming translation can be sensitive to buffering behavior -> flush chunks immediately on both relay and local HTTP response paths.
- A single WSS connection can become a bottleneck -> use request multiplexing with backpressure and allow future multiple-connection pools if needed.
- Cancellation can race with upstream completion -> treat cancel as best effort and make terminal request state idempotent.
- Logs may capture sensitive prompts or credentials -> default to metadata-only logs and redact authorization headers and request bodies.

## Migration Plan

1. Implement the local proxy and remote relay behind explicit configuration.
2. Validate the relay path with local loopback tests and mocked upstream responses.
3. Test against an OpenAI-compatible upstream with both streaming and non-streaming chat completions.
4. Configure agents to use the local proxy base URL.
5. Roll back by pointing agents back to their previous provider base URL or stopping the local proxy.

## Open Questions

- Which exact OpenAI-compatible endpoints are required for the first implementation beyond chat completions and model listing?
- Should the relay support gzip-compressed request payloads in the first version, or keep compression as a follow-up?
- Should one remote relay instance serve multiple local clients, or is the first deployment single-tenant?
