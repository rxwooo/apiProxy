## Why

The proxy currently exposes an OpenAI-compatible local API and forwards requests to a single upstream using OpenAI-style authorization. Supporting Anthropic's native Messages API lets Anthropic SDKs and clients use the same WSS relay, chunking, E2EE, cancellation, and remote credential boundary without adding a protocol translation layer in the first phase.

## What Changes

- Add first-phase native Anthropic API pass-through support for `POST /v1/messages`, `POST /v1/messages/count_tokens`, and compatible `GET /v1/models` requests.
- Add remote provider selection so the relay can apply Anthropic-specific upstream headers while preserving existing OpenAI behavior.
- Apply Anthropic credentials only on the remote relay and strip client-supplied Anthropic credentials from the local-to-remote forwarding path.
- Preserve Anthropic streaming SSE responses as byte streams through the existing relay protocol.
- Keep OpenAI-to-Anthropic request/response schema translation out of scope for this change.
- No breaking changes are intended for existing OpenAI-compatible endpoints or relay configuration.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `wss-api-relay`: Add native Anthropic API pass-through endpoints, provider-specific upstream authentication, Anthropic stream detection, and sensitive-header handling while preserving existing OpenAI relay behavior.

## Impact

- Affected local API surface: `src/local/server.js`, local route allow-listing, CORS headers, stream request detection.
- Affected remote forwarding: `src/remote/server.js`, provider-specific upstream URL/header construction, model mapping behavior for Anthropic JSON/SSE responses.
- Affected shared utilities/configuration: `src/shared/config.js`, `src/shared/http.js`, README and environment variable documentation.
- Affected tests: integration coverage for Anthropic non-streaming, streaming, token counting, models, credential injection, sensitive-header stripping, and OpenAI regression behavior.
