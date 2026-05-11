## Context

The current system has a local HTTP proxy that accepts a small OpenAI-compatible surface and relays allowed requests to a remote server over the existing WSS protocol. The remote relay owns upstream credentials, applies OpenAI-style authorization, forwards the request to the configured upstream, and streams or chunks the upstream response back to the local proxy.

Anthropic's native API is close enough to the current relay shape to support as pass-through: requests are normal HTTP JSON requests under `/v1`, streaming uses SSE, and responses can be relayed as bytes without schema conversion. The main differences are endpoint allow-listing, provider-specific authentication headers, required Anthropic version headers, and sensitive header handling.

## Goals / Non-Goals

**Goals:**

- Allow Anthropic SDKs and clients to call the local proxy using native Anthropic endpoints.
- Reuse the existing WSS relay protocol, chunking, E2EE, cancellation, timeout, response size limits, and streaming behavior.
- Keep provider API credentials on the remote relay.
- Preserve existing OpenAI-compatible behavior by default.
- Add a provider abstraction only where the current implementation is OpenAI-specific.

**Non-Goals:**

- Translate OpenAI Chat Completions requests into Anthropic Messages requests.
- Translate Anthropic responses or streaming events into OpenAI response shapes.
- Implement Anthropic beta feature semantics beyond forwarding a configured `anthropic-beta` header.
- Add new runtime dependencies.

## Decisions

### Add provider selection to remote upstream forwarding

Add a remote configuration value such as `UPSTREAM_PROVIDER`, defaulting to `openai`, with supported values `openai` and `anthropic`.

- For `openai`, preserve the current behavior: default `UPSTREAM_BASE_URL=https://api.openai.com` and apply `Authorization: <UPSTREAM_AUTH_SCHEME> <UPSTREAM_API_KEY>`.
- For `anthropic`, default `UPSTREAM_BASE_URL` to `https://api.anthropic.com` unless explicitly overridden, and apply `x-api-key: <UPSTREAM_API_KEY>` plus `anthropic-version: <ANTHROPIC_VERSION>`.
- Reject unsupported provider values during startup validation.

Alternative considered: keep only `UPSTREAM_AUTH_SCHEME` and ask users to emulate Anthropic headers through generic configuration. That avoids a new provider field, but it leaves required Anthropic versioning and sensitive-header behavior ambiguous and makes future provider-specific tests weaker.

### Add request-level automatic provider routing

Add `UPSTREAM_ROUTING` with supported values `single` and `auto`. `single` preserves the existing process-level provider behavior through `UPSTREAM_PROVIDER`. `auto` selects an upstream provider per request:

- `POST /v1/chat/completions` routes to OpenAI.
- `POST /v1/messages` and `POST /v1/messages/count_tokens` route to Anthropic.
- `GET /v1/models?provider=openai|anthropic` routes to the requested provider and removes the `provider` routing query parameter before forwarding upstream.
- `GET /v1/models` without a provider query routes to the default provider named by `UPSTREAM_PROVIDER`.

The remote relay should support provider-specific configuration names (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_AUTH_SCHEME`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_VERSION`, `ANTHROPIC_BETA`) while preserving existing `UPSTREAM_*` variables as single-provider compatibility aliases.

Alternative considered: choose `/v1/models` based on client headers. Query parameters are easier to test, visible in request logs, and avoid expanding the local trusted-header surface.

### Treat Anthropic support as native pass-through

Add local route support for Anthropic's native endpoint shape instead of translating between API schemas. The first phase should allow:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`

The relay should preserve method, path, selected non-sensitive headers, query string, and request body. Streaming detection should treat Anthropic `stream: true` on `/v1/messages` the same way the local proxy currently treats OpenAI chat streaming.

Alternative considered: expose Anthropic models through the existing `/v1/chat/completions` endpoint by converting request and response schemas. That is deferred because tools, system prompts, multimodal content, stop reasons, usage fields, and SSE event names would create a larger compatibility layer with different risks.

### Strip provider credentials at the local boundary

The local proxy should continue to remove client `Authorization` headers and should also remove Anthropic credential headers such as `x-api-key` before forwarding request metadata over the relay. If a client sends local placeholder credentials, those credentials must not reach the remote relay or upstream. The remote relay is responsible for adding configured provider credentials.

Alternative considered: allow client-supplied Anthropic credentials to pass through. That conflicts with the existing security model where provider credentials are applied remotely and would expose sensitive credentials over the relay path.

### Keep Anthropic SSE bytes provider-native

Anthropic streaming responses should be returned as SSE without converting event names or payload shapes. Existing response chunking and byte forwarding can preserve the stream. Model alias response rewriting can continue to operate on SSE `data:` JSON events when the upstream response contains a top-level `model` value, but it must not require Anthropic events to match OpenAI chunk schemas.

Alternative considered: parse and re-emit Anthropic streaming events into a normalized internal event format. That would add complexity without being necessary for pass-through support.

## Risks / Trade-offs

- Provider-specific behavior leaks into remote forwarding -> keep the abstraction small and isolated to config validation, header construction, endpoint defaults, and sensitive-header filtering.
- Anthropic clients may require headers beyond the first-phase defaults -> preserve non-sensitive client headers and add explicit config for `ANTHROPIC_BETA`, but do not attempt to understand beta semantics.
- Existing OpenAI behavior may regress -> keep `UPSTREAM_ROUTING=single` and `UPSTREAM_PROVIDER=openai` as compatibility defaults, and add regression tests for `/v1/chat/completions`, `/v1/models`, OpenAI auth headers, and streaming.
- Auto routing deployments may be partially configured -> validate required Anthropic version and production API keys at startup for `UPSTREAM_ROUTING=auto`, and return a clear relay error if a non-production request selects a provider without usable local configuration.
- Request size defaults may be lower than Anthropic's documented request size limits -> keep existing relay limits as operational safety limits and document that deployments can raise `MAX_REQUEST_BYTES` within the relay's validation constraints.
- Model alias response rewriting may not affect every Anthropic streaming event -> treat alias rewriting as best-effort for top-level `model` JSON fields and do not mutate nested event payloads unless covered by tests.

## Migration Plan

1. Deploy with compatibility defaults unchanged so existing OpenAI-compatible deployments continue to work.
2. For single-provider Anthropic deployments, set `UPSTREAM_PROVIDER=anthropic`, `UPSTREAM_API_KEY`, and `ANTHROPIC_VERSION`; set `UPSTREAM_BASE_URL` only when overriding the default Anthropic endpoint.
3. For automatic mixed-provider deployments, set `UPSTREAM_ROUTING=auto`, configure both OpenAI and Anthropic provider credentials, and use `?provider=openai|anthropic` when calling ambiguous model-list requests.
4. Point clients at the local proxy base URL and use their native provider API paths under `/v1`.
5. Roll back by restoring the previous binary or switching `UPSTREAM_ROUTING=single` with the desired `UPSTREAM_PROVIDER`.

## Open Questions

- None for the first phase. `GET /v1/models/{model_id}` remains out of scope until a later native Anthropic endpoint expansion.
