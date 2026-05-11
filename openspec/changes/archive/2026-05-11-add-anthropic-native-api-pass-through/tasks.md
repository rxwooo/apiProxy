## 1. Configuration

- [x] 1.1 Add `UPSTREAM_PROVIDER` parsing and startup validation with supported values `openai` and `anthropic`, defaulting to `openai`.
- [x] 1.2 Add Anthropic remote configuration for provider-specific default base URL, `ANTHROPIC_VERSION`, and optional `ANTHROPIC_BETA`.
- [x] 1.3 Ensure production validation still requires `UPSTREAM_API_KEY` and rejects unsupported provider or invalid Anthropic configuration clearly.

## 2. Local Proxy Surface

- [x] 2.1 Add local route support for `POST /v1/messages` and `POST /v1/messages/count_tokens`.
- [x] 2.2 Preserve `GET /v1/models` relay behavior for Anthropic deployments without schema conversion.
- [x] 2.3 Update stream request detection so `POST /v1/messages` with `"stream": true` is treated as streaming.
- [x] 2.4 Update CORS allow headers for Anthropic-compatible clients, including `x-api-key`, `anthropic-version`, and `anthropic-beta`.
- [x] 2.5 Extend forwarded-header filtering so client-supplied `x-api-key` is never relayed.

## 3. Remote Provider Forwarding

- [x] 3.1 Isolate upstream URL and header construction behind provider-aware helper functions.
- [x] 3.2 Preserve existing OpenAI upstream authorization behavior when `UPSTREAM_PROVIDER=openai` or no provider is configured.
- [x] 3.3 Implement Anthropic upstream forwarding with `x-api-key` and configured `anthropic-version` headers.
- [x] 3.4 Implement configured `anthropic-beta` forwarding for Anthropic provider deployments.
- [x] 3.5 Ensure client-supplied `anthropic-version` cannot override the remote relay's configured Anthropic version.
- [x] 3.6 Preserve native Anthropic JSON and SSE response bytes without OpenAI schema translation.

## 4. Tests

- [x] 4.1 Add config unit tests for provider defaults, Anthropic defaults, unsupported provider rejection, and Anthropic header configuration.
- [x] 4.2 Add integration coverage for `POST /v1/messages` non-streaming pass-through and remote Anthropic header injection.
- [x] 4.3 Add integration coverage for `POST /v1/messages/count_tokens` pass-through.
- [x] 4.4 Add integration coverage for Anthropic `GET /v1/models` pass-through.
- [x] 4.5 Add integration coverage for Anthropic SSE streaming pass-through without event conversion.
- [x] 4.6 Add tests proving client `x-api-key` and `Authorization` headers are stripped before upstream forwarding.
- [x] 4.7 Add regression coverage for existing OpenAI `/v1/chat/completions` and `/v1/models` behavior.

## 5. Documentation

- [x] 5.1 Update README configuration docs with Anthropic provider variables and an example deployment.
- [x] 5.2 Document that OpenAI-to-Anthropic schema translation is out of scope for first-phase native pass-through.
- [x] 5.3 Run the full test suite and record the result.

## 6. Request-Level Provider Routing

- [x] 6.1 Add `UPSTREAM_ROUTING` parsing and validation with `single` compatibility mode and `auto` request-level routing mode.
- [x] 6.2 Add provider-specific remote config for OpenAI and Anthropic while preserving legacy `UPSTREAM_*` compatibility aliases.
- [x] 6.3 Route OpenAI and Anthropic request paths to the correct provider when `UPSTREAM_ROUTING=auto`.
- [x] 6.4 Support `GET /v1/models?provider=openai|anthropic`, remove the routing query before upstream forwarding, and use the default provider when omitted.
- [x] 6.5 Add tests for auto routing, model-list provider selection, invalid provider rejection, and single-provider compatibility.
- [x] 6.6 Update README and `.env.example` with automatic routing configuration.
- [x] 6.7 Run OpenSpec validation and the full test suite.
