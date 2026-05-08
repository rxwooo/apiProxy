# API Proxy WSS Relay

This project provides a local OpenAI-compatible HTTP proxy that tunnels requests to a remote relay over WebSocket Secure. It is intended for environments where normal outbound HTTP requests are size-limited, while WSS traffic can carry chunked payloads.

```text
Agent -> Local Proxy -> WSS chunks -> Remote Relay -> Third-party model API
```

## Runtime

- Local proxy: listens on `127.0.0.1:8787` by default.
- Remote relay: listens on `0.0.0.0:8788/relay` by default.
- WSS payload chunks default to `8192` bytes.
- Provider API credentials are applied by the remote relay, not by the agent.

Supported first-version endpoints:

- `POST /v1/chat/completions`
- `GET /v1/models`
- `GET /healthz`

## Install

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and set deployment-specific values.

Local proxy variables:

- `LOCAL_HOST`: local bind address. Defaults to `127.0.0.1`.
- `LOCAL_PORT`: local HTTP port. Defaults to `8787`.
- `RELAY_URL`: WSS relay URL. Use `wss://...` in production.
- `RELAY_TOKEN`: bearer token used to authenticate to the remote relay.

Remote relay variables:

- `RELAY_HOST`: remote relay bind address. Defaults to `0.0.0.0`.
- `RELAY_PORT`: remote relay port. Defaults to `8788`.
- `RELAY_PATH`: WSS upgrade path. Defaults to `/relay`.
- `UPSTREAM_BASE_URL`: upstream model API base URL.
- `UPSTREAM_API_KEY`: upstream provider API key.
- `UPSTREAM_AUTH_SCHEME`: upstream auth scheme. Defaults to `Bearer`.
- `MODEL_ID_MAP`: optional JSON object mapping client-facing model aliases to upstream model ids.

Example:

```env
MODEL_ID_MAP={"A":"provider-real-model-id","fast":"provider-fast-model-id"}
```

With that configuration, the client can send `"model":"A"` and the remote relay will forward `"model":"provider-real-model-id"` to the upstream API. If the upstream JSON or SSE response includes `"model":"provider-real-model-id"`, the relay rewrites it back to `"model":"A"` before returning it to the client.

Shared variables:

- `CHUNK_SIZE`: max application payload bytes per WSS chunk. Defaults to `8192` and must be at most `9216`.
- `REQUEST_TIMEOUT_MS`: per-request timeout.
- `RELAY_CONNECT_TIMEOUT_MS`: local proxy WSS connection timeout.
- `HEARTBEAT_INTERVAL_MS`: WSS ping interval.
- `MAX_REQUEST_BYTES`: max reassembled request size.
- `MAX_RESPONSE_BYTES`: max relayed upstream response size.
- `MAX_CONCURRENT_REQUESTS`: max concurrent requests per relay session.
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error`, or `silent`.

Production startup validation requires:

- `RELAY_TOKEN`
- `UPSTREAM_API_KEY` on the remote relay
- `RELAY_URL` using `wss://` on the local proxy
- `UPSTREAM_BASE_URL` using `https://` on the remote relay
- local proxy bound to loopback unless `ALLOW_PUBLIC_LOCAL_PROXY=true`

## Run

Start the remote relay:

```bash
npm run start:relay
```

Start the local proxy:

```bash
npm run start:local
```

Point the agent at the local proxy:

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=unused-by-local-proxy
```

Then send a normal OpenAI-compatible request:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"your-upstream-model","messages":[{"role":"user","content":"hello"}]}'
```

For streaming:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"your-upstream-model","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

## Tests

```bash
npm test
```

The test suite covers chunking and digest validation, request reassembly, large requests over the relay path, non-streaming and streaming responses, cancellation, relay disconnects, invalid auth, upstream errors, timeouts, and digest mismatch handling.

## Security Notes

Default logs are metadata-only and redact credentials and request/response bodies. Keep the local proxy on loopback unless you have a separate access-control layer. Keep provider credentials on the remote relay when possible.
