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
- `RELAY_E2EE`: application-layer relay encryption mode: `off`, `optional`, or `required`. Use `required` when the WSS connection traverses an HTTPS-inspecting proxy.
- `RELAY_E2EE_KEY_ID`: key id presented by the local proxy during the E2EE handshake.
- `RELAY_E2EE_PSK_B64`: base64-encoded pre-shared E2EE key. Use at least 32 random bytes.
- `RELAY_PROXY`: optional explicit HTTP/HTTPS proxy URL for the local client's outbound WSS connection to the remote relay.
- `RELAY_NO_PROXY`: optional comma-separated relay host bypass list for `RELAY_PROXY`.

Explicit relay proxy example:

```env
RELAY_PROXY=http://127.0.0.1:7890
RELAY_NO_PROXY=localhost,127.0.0.1,.local
```

Proxy authentication can be embedded in the proxy URL:

```env
RELAY_PROXY=http://user:password@proxy.example.com:8080
```

The local client does not automatically evaluate Windows system proxy scripts or PAC files. If browser or proxied `curl` access works but the local client logs `Relay connection timed out`, configure `RELAY_PROXY` with the explicit proxy endpoint that works for the relay URL. Logs show whether the relay connection is proxied and redact proxy credentials.

Remote relay variables:

- `RELAY_HOST`: remote relay bind address. Defaults to `0.0.0.0`.
- `RELAY_PORT`: remote relay port. Defaults to `8788`.
- `RELAY_PATH`: WSS upgrade path. Defaults to `/relay`.
- `RELAY_TOKEN`: bearer token used to authenticate local relay sessions. With `RELAY_E2EE=required`, this token is sent inside the encrypted relay envelope instead of the WebSocket upgrade header.
- `RELAY_E2EE`: application-layer relay encryption mode: `off`, `optional`, or `required`.
- `RELAY_E2EE_KEY_ID` and `RELAY_E2EE_PSK_B64`: single-key E2EE configuration for simple deployments.
- `RELAY_E2EE_KEYS_JSON`: optional JSON object mapping E2EE key ids to base64-encoded keys for rotation, for example `{"main":"..."}`.
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

## Relay E2EE

When a corporate HTTP proxy performs HTTPS inspection, WSS is no longer end-to-end between the local proxy and the remote relay. Set `RELAY_E2EE=required` on both sides to wrap all relay messages in an authenticated encrypted envelope after a short handshake.

Generate a key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Local proxy:

```env
RELAY_E2EE=required
RELAY_E2EE_KEY_ID=main
RELAY_E2EE_PSK_B64=<generated-base64-key>
```

Remote relay, single key:

```env
RELAY_E2EE=required
RELAY_E2EE_KEY_ID=main
RELAY_E2EE_PSK_B64=<generated-base64-key>
```

Remote relay, key rotation:

```env
RELAY_E2EE=required
RELAY_E2EE_KEYS_JSON={"old":"<old-base64-key>","main":"<generated-base64-key>"}
```

In required mode, the local proxy does not send `RELAY_TOKEN` in the WebSocket upgrade `Authorization` header. It sends the token inside the encrypted session after the E2EE handshake. If the relay token was previously used through an inspecting proxy, rotate it before switching production traffic to the encrypted path.

E2EE protects relay paths, headers, prompt bodies, response headers, response bodies, relay errors, and relay authentication from intermediaries. It does not hide destination host, port, connection timing, traffic volume, the fact that WebSocket is used, or plaintext inside the local proxy, remote relay, or upstream provider.

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

## Windows Proxy Checks

Check whether direct access to the remote relay works:

```powershell
curl.exe -vk --noproxy "*" https://relay.example.com/healthz
```

Check whether an explicit proxy can reach the relay:

```powershell
curl.exe -vk -x http://127.0.0.1:7890 https://relay.example.com/healthz
```

Check the WSS upgrade through an explicit proxy:

```powershell
curl.exe -vk -i --http1.1 -x http://127.0.0.1:7890 `
  -H "Connection: Upgrade" `
  -H "Upgrade: websocket" `
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" `
  -H "Sec-WebSocket-Version: 13" `
  -H "Authorization: Bearer your-relay-token" `
  https://relay.example.com/relay
```

Expected WebSocket result:

```text
HTTP/1.1 101 Switching Protocols
```

## Tests

```bash
npm test
```

The test suite covers chunking and digest validation, request reassembly, large requests over the relay path, non-streaming and streaming responses, cancellation, relay disconnects, invalid auth, upstream errors, timeouts, and digest mismatch handling.

## Security Notes

Default logs are metadata-only and redact credentials and request/response bodies. Keep the local proxy on loopback unless you have a separate access-control layer. Keep provider credentials on the remote relay when possible.
