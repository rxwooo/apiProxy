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

### Requirement: Explicit local relay outbound proxy
The local proxy SHALL support an explicitly configured outbound proxy for the WebSocket connection to the remote relay.

#### Scenario: Relay proxy is configured
- **WHEN** the local proxy starts with a valid `RELAY_PROXY` configuration
- **THEN** the local relay client MUST establish the remote relay WebSocket connection through that proxy

#### Scenario: Relay proxy is not configured
- **WHEN** the local proxy starts without `RELAY_PROXY`
- **THEN** the local relay client MUST preserve the existing direct WebSocket connection behavior

#### Scenario: Relay proxy configuration is invalid
- **WHEN** the local proxy starts with a malformed or unsupported `RELAY_PROXY` value
- **THEN** startup validation MUST reject the configuration with a clear error

#### Scenario: Relay host matches proxy bypass list
- **WHEN** `RELAY_PROXY` is configured and the relay host matches `RELAY_NO_PROXY`
- **THEN** the local relay client MUST connect directly to the relay without using the proxy

#### Scenario: Proxied relay authentication succeeds
- **WHEN** the local relay client connects through a proxy with valid relay credentials
- **THEN** the remote relay MUST receive the normal relay authentication and accept the WSS session

#### Scenario: Proxied relay connection fails
- **WHEN** the local relay client cannot establish the WebSocket connection through the configured proxy
- **THEN** the local proxy MUST return a gateway-style error and log diagnostic metadata indicating proxy mode was used

#### Scenario: Proxy URL contains credentials
- **WHEN** `RELAY_PROXY` includes username or password information
- **THEN** logs MUST redact proxy credentials while preserving non-sensitive diagnostic information such as proxy host and port

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

### Requirement: Application-layer relay encryption
The system SHALL support an application-layer encrypted relay envelope between the local proxy and the remote relay so that relay message contents remain confidential from intermediaries that can inspect the outer WSS/TLS connection.

#### Scenario: Encrypted relay session is established
- **WHEN** the local proxy and remote relay are configured with compatible E2EE mode, key id, pre-shared key, and encryption suite
- **THEN** the local proxy and remote relay MUST complete an E2EE handshake before relaying application requests
- **AND** both sides MUST derive fresh per-session encryption keys from the configured key material and per-session nonces

#### Scenario: Relay messages are sealed after handshake
- **WHEN** an E2EE handshake has completed successfully
- **THEN** the local proxy MUST send relay request metadata, request chunks, request completion, and cancellation messages only as authenticated encrypted frames
- **AND** the remote relay MUST send response metadata, response chunks, response completion, and relay errors only as authenticated encrypted frames

#### Scenario: Intermediary cannot read relay contents
- **WHEN** an intermediary observes WebSocket frames for an E2EE relay session
- **THEN** the intermediary MUST NOT be able to read request paths, forwarded headers, request bodies, response headers, response bodies, relay tokens, or relay error details from those frames without the session keys

#### Scenario: Encrypted relay preserves existing semantics
- **WHEN** a request is relayed through an E2EE session
- **THEN** the system MUST preserve existing request chunking, reassembly validation, response streaming, cancellation, timeout, model mapping, and upstream forwarding behavior

### Requirement: E2EE relay authentication
The system SHALL authenticate encrypted relay sessions without exposing sensitive relay credentials in the outer WebSocket upgrade request when E2EE is required.

#### Scenario: Valid encrypted relay authentication
- **WHEN** E2EE is required and the local proxy sends valid relay authentication inside the encrypted session
- **THEN** the remote relay MUST accept the session and allow request relay messages after authentication succeeds

#### Scenario: Invalid encrypted relay authentication
- **WHEN** E2EE is required and the local proxy sends missing or invalid relay authentication inside the encrypted session
- **THEN** the remote relay MUST reject the session or close it before accepting request relay messages

#### Scenario: Relay token is not sent in plaintext when E2EE is required
- **WHEN** E2EE is required on the local proxy
- **THEN** the local relay client MUST NOT send the relay token in the WebSocket upgrade `Authorization` header
- **AND** it MUST send relay authentication only inside an authenticated encrypted frame

#### Scenario: Unauthenticated encrypted session times out
- **WHEN** a remote relay accepts a socket for an E2EE-required session and the client does not complete encrypted authentication within the allowed handshake window
- **THEN** the remote relay MUST close the session without accepting request relay messages

### Requirement: E2EE downgrade protection
The system SHALL fail closed when E2EE is configured as required.

#### Scenario: Required local E2EE cannot be established
- **WHEN** the local proxy is configured with E2EE required and cannot complete an E2EE handshake with the remote relay
- **THEN** the local proxy MUST fail the relay connection and MUST NOT send plaintext relay messages or plaintext relay authentication

#### Scenario: Required remote E2EE receives plaintext relay message
- **WHEN** the remote relay is configured with E2EE required and receives a plaintext relay request message before a successful E2EE handshake and encrypted authentication
- **THEN** the remote relay MUST reject the message and close or fail the session

#### Scenario: Required E2EE key mismatch
- **WHEN** the local proxy and remote relay are configured with incompatible E2EE key material or unsupported encryption suites
- **THEN** the relay session MUST fail before any request metadata or request body is relayed

### Requirement: E2EE key configuration and rotation
The system SHALL provide configuration for enabling relay E2EE and rotating E2EE keys.

#### Scenario: Local E2EE key configuration is valid
- **WHEN** the local proxy starts with E2EE enabled
- **THEN** startup validation MUST require a valid E2EE mode, key id, and base64-encoded pre-shared key for the selected key id

#### Scenario: Remote E2EE key configuration is valid
- **WHEN** the remote relay starts with E2EE enabled
- **THEN** startup validation MUST require a valid E2EE mode and at least one base64-encoded pre-shared key addressable by key id

#### Scenario: Remote relay supports key rotation
- **WHEN** the remote relay is configured with multiple E2EE keys and the local proxy presents a configured key id during handshake
- **THEN** the remote relay MUST use the key material associated with that key id for session key derivation

#### Scenario: E2EE configuration is invalid
- **WHEN** E2EE is enabled and the configured mode, key id, key set, or key encoding is invalid
- **THEN** startup validation MUST reject the configuration with a clear error

### Requirement: Local Anthropic-compatible proxy
The system SHALL provide a local HTTP API surface that Anthropic-compatible clients can use as an Anthropic-compatible base URL while preserving the existing OpenAI-compatible API surface.

#### Scenario: Client sends Anthropic message request to local proxy
- **WHEN** an agent sends `POST /v1/messages` to the local proxy with a JSON request body
- **THEN** the local proxy MUST accept the request body and prepare it for relay over WSS
- **AND** the relayed request metadata MUST preserve the original method, path, query string, selected non-sensitive headers, and request body

#### Scenario: Client sends Anthropic token counting request to local proxy
- **WHEN** an agent sends `POST /v1/messages/count_tokens` to the local proxy with a JSON request body
- **THEN** the local proxy MUST accept the request body and prepare it for relay over WSS
- **AND** the relayed request metadata MUST preserve the original method, path, query string, selected non-sensitive headers, and request body

#### Scenario: Client requests Anthropic model list
- **WHEN** an agent sends `GET /v1/models` to the local proxy for an Anthropic upstream deployment
- **THEN** the local proxy MUST relay the request to the configured upstream through the WSS relay path
- **AND** the local proxy MUST return the upstream model-list response without converting it to another provider schema

### Requirement: Anthropic upstream provider forwarding
The remote relay SHALL support provider-specific upstream forwarding for Anthropic while preserving the existing OpenAI provider behavior.

#### Scenario: Anthropic provider applies required upstream headers
- **WHEN** the remote relay forwards a request with `UPSTREAM_PROVIDER=anthropic`
- **THEN** it MUST send the configured upstream API key using the `x-api-key` header
- **AND** it MUST send the configured Anthropic API version using the `anthropic-version` header
- **AND** it MUST NOT synthesize OpenAI-style upstream authorization for that request

#### Scenario: Anthropic beta header is configured
- **WHEN** the remote relay forwards a request with `UPSTREAM_PROVIDER=anthropic` and an Anthropic beta configuration is present
- **THEN** it MUST send the configured value using the `anthropic-beta` header

#### Scenario: OpenAI provider remains default-compatible
- **WHEN** the remote relay starts without an explicit provider configuration
- **THEN** it MUST preserve the existing OpenAI-compatible upstream forwarding behavior
- **AND** existing OpenAI-compatible requests MUST continue to receive OpenAI-style upstream authorization

#### Scenario: Unsupported provider is configured
- **WHEN** the remote relay starts with an unsupported upstream provider value
- **THEN** startup validation MUST reject the configuration with a clear error

### Requirement: Request-level upstream provider routing
The remote relay SHALL support automatic provider selection per request when configured for automatic upstream routing.

#### Scenario: OpenAI path routes to OpenAI provider
- **WHEN** the remote relay receives a request for `POST /v1/chat/completions` with automatic upstream routing enabled
- **THEN** it MUST forward the request to the configured OpenAI upstream base URL
- **AND** it MUST apply OpenAI provider authentication headers

#### Scenario: Anthropic message path routes to Anthropic provider
- **WHEN** the remote relay receives a request for `POST /v1/messages` with automatic upstream routing enabled
- **THEN** it MUST forward the request to the configured Anthropic upstream base URL
- **AND** it MUST apply Anthropic provider authentication headers

#### Scenario: Anthropic token counting path routes to Anthropic provider
- **WHEN** the remote relay receives a request for `POST /v1/messages/count_tokens` with automatic upstream routing enabled
- **THEN** it MUST forward the request to the configured Anthropic upstream base URL
- **AND** it MUST apply Anthropic provider authentication headers

#### Scenario: Model list request selects provider explicitly
- **WHEN** the remote relay receives `GET /v1/models?provider=anthropic` with automatic upstream routing enabled
- **THEN** it MUST forward the request to the configured Anthropic upstream base URL
- **AND** it MUST remove the `provider` routing parameter before forwarding the upstream request

#### Scenario: Model list request omits provider
- **WHEN** the remote relay receives `GET /v1/models` with automatic upstream routing enabled and no provider routing parameter
- **THEN** it MUST forward the request using the configured default upstream provider

#### Scenario: Model list request uses unsupported provider
- **WHEN** the remote relay receives `GET /v1/models?provider=unsupported` with automatic upstream routing enabled
- **THEN** it MUST reject the request with a clear relay error

#### Scenario: Single provider routing remains compatible
- **WHEN** the remote relay starts without automatic upstream routing enabled
- **THEN** it MUST preserve the existing single-provider routing behavior selected by `UPSTREAM_PROVIDER`

### Requirement: Anthropic sensitive header protection
The system SHALL prevent client-supplied provider credentials from being relayed or sent upstream for Anthropic requests.

#### Scenario: Client sends Anthropic API key to local proxy
- **WHEN** an agent request to the local proxy includes an `x-api-key` header
- **THEN** the local proxy MUST omit that header from relayed request metadata
- **AND** the remote relay MUST apply only the configured upstream API key when forwarding to Anthropic

#### Scenario: Client sends local authorization to Anthropic endpoint
- **WHEN** an agent request to an Anthropic-compatible local endpoint includes an `Authorization` header
- **THEN** the local proxy MUST omit that header from relayed request metadata
- **AND** the remote relay MUST apply provider-specific upstream authentication from remote configuration

#### Scenario: Client sends Anthropic version header
- **WHEN** an agent request includes an `anthropic-version` header and the remote relay is configured with `UPSTREAM_PROVIDER=anthropic`
- **THEN** the remote relay MUST send the configured Anthropic API version upstream
- **AND** the client-supplied version value MUST NOT override the remote configuration

### Requirement: Native Anthropic response relay
The system SHALL preserve native Anthropic non-streaming and streaming response shapes through the relay without translating them into OpenAI response schemas.

#### Scenario: Anthropic non-streaming response succeeds
- **WHEN** the upstream Anthropic API returns a complete non-streaming JSON response
- **THEN** the remote relay MUST send response metadata and response chunks to the local proxy
- **AND** the local proxy MUST return the corresponding HTTP status, headers, and body to the agent without converting the JSON schema

#### Scenario: Anthropic streaming response succeeds
- **WHEN** an agent sends `POST /v1/messages` with `"stream": true` and the upstream Anthropic API returns an SSE response
- **THEN** the remote relay MUST forward SSE bytes to the local proxy as they become available
- **AND** the local proxy MUST expose a streaming HTTP response compatible with the Anthropic client
- **AND** the system MUST NOT convert Anthropic event names or event payloads into OpenAI streaming chunks

#### Scenario: OpenAI request is not translated to Anthropic
- **WHEN** an agent sends an OpenAI-compatible request such as `POST /v1/chat/completions`
- **THEN** the system MUST NOT transform the request body or path into an Anthropic `POST /v1/messages` request

