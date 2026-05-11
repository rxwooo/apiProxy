## ADDED Requirements

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
