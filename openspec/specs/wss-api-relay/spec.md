## Purpose

Provide an OpenAI-compatible local proxy and remote WSS relay that can move large model API requests through constrained network environments while preserving streaming behavior, authentication, cancellation, model id mapping, and safe error handling.

## Requirements

### Requirement: Local OpenAI-compatible proxy
The system SHALL provide a local HTTP API proxy that agent clients can use as an OpenAI-compatible base URL.

#### Scenario: Agent sends chat completion request to local proxy
- **WHEN** an agent sends `POST /v1/chat/completions` to the local proxy
- **THEN** the local proxy MUST accept the request body and prepare it for relay over WSS

#### Scenario: Agent requests available models
- **WHEN** an agent sends `GET /v1/models` to the local proxy
- **THEN** the local proxy MUST return a model-list response obtained through the relay path or a configured upstream-compatible source

#### Scenario: Local proxy default bind address
- **WHEN** the local proxy starts without an explicit public bind configuration
- **THEN** it MUST listen only on a loopback address

### Requirement: Authenticated WSS relay session
The system SHALL establish an authenticated WSS session between the local proxy and the remote relay before forwarding model API requests.

#### Scenario: Valid relay authentication
- **WHEN** the local proxy connects to the remote relay with valid relay credentials
- **THEN** the remote relay MUST accept the WSS session and allow request relay messages

#### Scenario: Invalid relay authentication
- **WHEN** the local proxy connects to the remote relay with missing or invalid relay credentials
- **THEN** the remote relay MUST reject the WSS session or close it before accepting request relay messages

#### Scenario: Relay health check
- **WHEN** the WSS session remains open without active requests
- **THEN** the local proxy and remote relay MUST use ping/pong or equivalent health checks to detect broken connections

### Requirement: Chunked request transport
The system SHALL transmit local HTTP request data over WSS using application-level chunks that do not exceed the configured maximum chunk size.

#### Scenario: Large request is chunked below limit
- **WHEN** a local HTTP request body is larger than the configured maximum chunk size
- **THEN** the local proxy MUST split the payload into ordered WSS chunks whose payload bytes do not exceed that maximum

#### Scenario: Request metadata is sent before chunks
- **WHEN** the local proxy starts relaying a request
- **THEN** it MUST send request metadata including request id, method, path, selected headers, streaming preference, encoding, and expected total bytes before payload chunks

#### Scenario: Multiple requests share one WSS session
- **WHEN** multiple agent requests are active at the same time
- **THEN** the relay protocol MUST identify every request and response message with a request id

### Requirement: Remote request reassembly and validation
The remote relay SHALL reassemble chunked request payloads by request id and validate them before upstream forwarding.

#### Scenario: Complete request passes validation
- **WHEN** the remote relay receives all chunks for a request and the final digest matches the reassembled payload
- **THEN** it MUST mark the request as valid and eligible for upstream forwarding

#### Scenario: Digest validation fails
- **WHEN** the remote relay receives a request end message with a digest that does not match the reassembled payload
- **THEN** it MUST reject the request, send an error for that request id, and release buffered data for that request

#### Scenario: Request exceeds configured limit
- **WHEN** the reassembled request would exceed the configured maximum request size
- **THEN** the remote relay MUST reject the request and stop accepting more chunks for that request id

#### Scenario: Out-of-order or duplicate chunk is received
- **WHEN** the remote relay receives an out-of-order chunk or duplicate chunk for a request id
- **THEN** it MUST reject the affected request or request retransmission according to the relay protocol rules

### Requirement: Upstream API forwarding
The remote relay SHALL forward validated requests to the configured third-party model API.

#### Scenario: Valid request is forwarded upstream
- **WHEN** a request passes relay validation
- **THEN** the remote relay MUST call the configured upstream API using the preserved method, path, content type, and request body

#### Scenario: Upstream credentials are applied remotely
- **WHEN** the remote relay forwards a request to the upstream model API
- **THEN** it MUST apply the configured upstream authentication credentials on the remote side

#### Scenario: Upstream returns error response
- **WHEN** the upstream model API returns a non-success HTTP status
- **THEN** the remote relay MUST relay the upstream status and response body back to the local proxy when safe to do so

### Requirement: Server-side model id mapping
The remote relay SHALL support configured client-facing model aliases that are mapped to upstream model ids before requests are forwarded.

#### Scenario: Chat completion uses configured model alias
- **WHEN** a relayed JSON request contains a top-level `model` value that matches a configured model alias
- **THEN** the remote relay MUST replace that value with the configured upstream model id before forwarding the request

#### Scenario: Request uses unmapped model id
- **WHEN** a relayed JSON request contains a top-level `model` value without a configured mapping
- **THEN** the remote relay MUST forward the original model value unchanged

#### Scenario: Model mapping is not configured
- **WHEN** no model mapping configuration is provided
- **THEN** the remote relay MUST forward request bodies unchanged

#### Scenario: Non-streaming response contains mapped upstream model id
- **WHEN** an upstream JSON response contains the mapped upstream model id for the active request
- **THEN** the remote relay MUST replace that response `model` value with the original client-facing model alias before returning it

#### Scenario: Streaming response contains mapped upstream model id
- **WHEN** an upstream SSE response data event contains the mapped upstream model id for the active request
- **THEN** the remote relay MUST replace that event `model` value with the original client-facing model alias before returning it

### Requirement: Non-streaming response relay
The system SHALL deliver non-streaming upstream responses back to the agent through the WSS relay and local HTTP response.

#### Scenario: Non-streaming response succeeds
- **WHEN** the upstream model API returns a complete non-streaming JSON response
- **THEN** the remote relay MUST send response metadata and response chunks to the local proxy
- **AND** the local proxy MUST return the corresponding HTTP status, headers, and body to the agent

#### Scenario: Response is larger than one WSS chunk
- **WHEN** the upstream response body is larger than the configured maximum chunk size
- **THEN** the remote relay MUST split the response body into ordered chunks whose payload bytes do not exceed that maximum

### Requirement: Streaming response relay
The system SHALL preserve streaming model responses through the remote relay and local proxy.

#### Scenario: Upstream sends streaming response
- **WHEN** the upstream model API returns a streaming response for an agent request
- **THEN** the remote relay MUST forward response bytes to the local proxy as they become available
- **AND** the local proxy MUST expose a streaming HTTP response compatible with the agent client

#### Scenario: Streaming response completes
- **WHEN** the upstream streaming response ends normally
- **THEN** the remote relay MUST send a response end message for the request id
- **AND** the local proxy MUST close the local streaming response cleanly

### Requirement: Request cancellation
The system SHALL propagate agent-side cancellation to the remote relay and upstream request.

#### Scenario: Agent aborts local HTTP request
- **WHEN** the agent closes or aborts an in-flight local HTTP request
- **THEN** the local proxy MUST send a cancellation message for the corresponding request id to the remote relay

#### Scenario: Remote relay receives cancellation
- **WHEN** the remote relay receives a cancellation message for an active upstream request
- **THEN** it MUST attempt to abort the upstream request and release local state for that request id

### Requirement: Relay failure handling
The system SHALL return clear errors when the relay path cannot complete a request.

#### Scenario: WSS relay is unavailable
- **WHEN** the local proxy receives an agent request but cannot establish or use the WSS relay session
- **THEN** the local proxy MUST return a gateway-style error response to the agent

#### Scenario: Request times out
- **WHEN** a relayed request exceeds the configured timeout before completion
- **THEN** the system MUST terminate the request, release associated resources, and return a timeout error for the affected request id

### Requirement: Sensitive data protection
The system SHALL protect credentials and prompt data handled by the relay.

#### Scenario: Logs are emitted
- **WHEN** the local proxy or remote relay writes request logs
- **THEN** logs MUST omit or redact authorization headers, upstream API keys, relay credentials, and request or response bodies by default

#### Scenario: Local proxy configuration is used
- **WHEN** an agent is configured to use the local proxy
- **THEN** the agent MUST NOT need direct access to the third-party provider API key when the remote relay is configured with upstream credentials
