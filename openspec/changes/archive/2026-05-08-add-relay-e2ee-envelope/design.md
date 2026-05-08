## Context

The project already uses a local OpenAI-compatible HTTP proxy, a remote WSS relay, and a binary/JSON relay protocol for chunked requests and responses. WSS normally protects the relay traffic in transit, but in the target deployment the Windows client must use an enterprise HTTP proxy that can perform HTTPS inspection. In that case the proxy can terminate TLS, observe WebSocket headers and frames, and potentially read prompt data, request metadata, response bodies, and relay credentials.

The data owner wants confidentiality between the local proxy and the remote relay, even when the outer HTTPS/WSS connection is inspected. The remote relay must still decrypt requests because it applies model mapping, upstream credentials, request validation, and upstream forwarding.

Current relay flow:

```text
Agent -> Local Proxy -> WSS/TLS -> Inspecting Proxy -> Reverse Proxy -> Remote Relay -> Upstream
```

Target relay flow:

```text
Agent -> Local Proxy -> WSS/TLS -> Inspecting Proxy -> Reverse Proxy -> Remote Relay -> Upstream
                         \________________ application E2EE ________________/
```

## Goals / Non-Goals

**Goals:**

- Protect relay request metadata, request bodies, response metadata, response bodies, and relay authentication from HTTPS-inspecting intermediaries.
- Preserve existing local HTTP API behavior for agent clients.
- Preserve existing relay semantics for chunking, streaming, cancellation, model mapping, timeouts, and error handling.
- Support fail-closed deployments where plaintext relay traffic is rejected.
- Support key rotation through key ids and multiple remote-side keys.
- Keep the first implementation within the existing Node.js standard library where practical.

**Non-Goals:**

- Protect data from the local proxy process, remote relay process, or upstream model provider.
- Encrypt traffic between the agent and the local loopback proxy.
- Replace WSS/TLS; the outer channel still provides transport compatibility and baseline security.
- Add browser-style PKI, certificates, or an external KMS in the first version.
- Hide traffic volume, timing, destination host, destination port, or the fact that a WebSocket relay is being used.

## Decisions

### Use an application-layer sealed envelope around existing relay frames

The implementation will encrypt complete existing relay frames instead of only request and response bodies. The plaintext for encryption is the bytes produced by the existing protocol encoders:

- JSON frames from `encodeJsonMessage()`
- binary chunk frames from `encodeChunkMessage()`

After encryption, the WebSocket carries a single outer `sealed` binary frame format:

```text
outer header:
  version
  type = sealed
  sessionId
  seq
  ciphertextBytes

outer payload:
  ciphertext || authTag
```

The receiver authenticates and decrypts the sealed frame, then routes the recovered plaintext through the existing JSON or binary protocol decoder. This keeps request reassembly, response streaming, cancellation, and model mapping code mostly unchanged.

Alternatives considered:

- Encrypt only request and response bodies. Rejected because `request.start`, `response.start`, and `error` messages contain paths, headers, status, stream state, sizes, and diagnostic content that can be sensitive.
- Replace the relay protocol entirely. Rejected because the current protocol already handles chunking, ordering, streaming, and cancellation.

### Use PSK-based session keys with fresh nonces

The first version will use a configured pre-shared key and derive per-session keys using HKDF-SHA256:

```text
sessionSecret = HKDF(PSK, clientNonce || serverNonce, transcriptHash)
clientToServerKey = HKDF(sessionSecret, "relay-e2ee c2s")
serverToClientKey = HKDF(sessionSecret, "relay-e2ee s2c")
```

The handshake will be:

```text
Local  -> Remote: e2ee.client_hello { keyId, clientNonce, suites }
Remote -> Local : e2ee.server_hello { sessionId, serverNonce, suite }
Local  -> Remote: sealed session.auth { relayToken, keyId, mode }
Remote -> Local : sealed ack
```

The `keyId` is visible and used only for remote key lookup. The PSK and relay token are never sent in plaintext. Each connection uses fresh random nonces.

Alternatives considered:

- Keep using only the WebSocket `Authorization` header. Rejected for E2EE-required deployments because an inspecting proxy can read the outer HTTP upgrade headers.
- Use public-key certificates. Rejected for the first version because the project currently has a simple two-party deployment model and no certificate lifecycle.
- Add X25519 for forward secrecy now. Deferred because PSK-only HKDF is simpler to operate and satisfies the immediate proxy-inspection threat model. This can be added later as a compatible suite.

### Use AEAD with sequence-bound nonces

Sealed frames will use an AEAD cipher available through Node.js `crypto`, preferably `aes-256-gcm` for the first implementation. Each direction has an independent key and monotonic sequence counter.

The AEAD additional authenticated data will bind:

```text
protocol version
sessionId
direction
sequence number
outer message type
```

The receiver MUST reject duplicate, skipped, or out-of-order sequence numbers for a direction. WebSocket is ordered, but sequence validation prevents replayed frames and catches envelope state corruption.

Alternatives considered:

- Random nonces per frame. Rejected because deterministic sequence-derived nonces are easier to validate and avoid accidental nonce reuse under one session key.
- AES-CBC plus HMAC. Rejected because AEAD is less error-prone and already provides authenticated encryption.

### Fail closed when E2EE is required

Configuration will support at least:

```env
RELAY_E2EE=off|optional|required
RELAY_E2EE_KEY_ID=<key-id>
RELAY_E2EE_PSK_B64=<base64 secret>
RELAY_E2EE_KEYS_JSON={"<key-id>":"<base64 secret>"}
```

Local behavior:

- `off`: preserve current plaintext relay behavior.
- `optional`: attempt E2EE when configured and allow plaintext only if explicitly configured for compatibility.
- `required`: require successful E2EE handshake before any relay request; never send relay auth or relay messages in plaintext.

Remote behavior:

- `off`: preserve current plaintext relay behavior.
- `optional`: accept E2EE sessions and plaintext sessions.
- `required`: accept only E2EE handshake messages before authentication; reject plaintext relay messages and unauthenticated sessions.

Production deployments that opt into E2EE for proxy inspection should use `required` on both local and remote sides.

### Move sensitive relay authentication into the encrypted channel

When E2EE is required, the local relay client will not send `RELAY_TOKEN` in the WebSocket upgrade `Authorization` header. The remote relay will allow the upgrade on the configured relay path, start a short E2EE handshake timeout, and process no relay requests until it receives a valid encrypted `session.auth` message.

This means the remote relay may temporarily accept unauthenticated sockets in required mode. Mitigations:

- only the relay path is accepted,
- handshake timeout is short,
- request relay messages before authentication are rejected,
- existing max connection and resource limits should remain enforced by the process or deployment environment.

### Keep encrypted and plaintext code paths explicit

The E2EE state should be represented as a session wrapper around send and receive operations, not as scattered conditionals throughout request forwarding. A small shared module can expose:

- handshake helpers,
- key derivation,
- seal/open functions,
- frame encoding/decoding,
- config parsing helpers.

The local and remote relay code should decide once per WebSocket session whether it is encrypted, then use the session wrapper for all subsequent relay frames.

## Risks / Trade-offs

- PSK compromise exposes current and recorded PSK-only sessions -> rotate keys, support multiple remote keys, avoid logging keys, and consider a later X25519 suite for forward secrecy.
- Inspecting proxies still see traffic metadata -> document that E2EE protects contents, not timing, size, destination, or connection existence.
- Required E2EE changes upgrade authentication behavior -> add integration tests for required mode, optional mode, plaintext rejection, and invalid encrypted auth.
- Handshake bugs can break all relay traffic -> keep `off` and `optional` modes for staged rollout, then switch production to `required`.
- Remote relay accepts unauthenticated sockets briefly in required mode -> enforce a short handshake timeout and reject all non-handshake messages until authenticated.
- Ciphertext expansion increases frame size -> include auth tag/header overhead in chunk sizing or document that encrypted WebSocket frames may be slightly larger than `CHUNK_SIZE`.

## Migration Plan

1. Implement config parsing and validation for E2EE modes and keys.
2. Add the shared E2EE envelope module and unit tests.
3. Add optional encrypted session support on the remote relay while preserving plaintext behavior.
4. Add optional encrypted session support on the local relay client.
5. Verify existing relay tests still pass with E2EE off.
6. Add integration tests with E2EE required on both sides.
7. Rotate any relay token that may have crossed the inspected proxy in plaintext.
8. Deploy remote relay with `RELAY_E2EE=optional` and keys configured.
9. Deploy local proxy with `RELAY_E2EE=required`.
10. After verification, set remote relay to `RELAY_E2EE=required`.

Rollback is to set both sides back to `RELAY_E2EE=off` or `optional` and restart. This restores current WSS behavior but also restores exposure to HTTPS inspection.

## Open Questions

- Should production validation require `RELAY_E2EE=required` whenever `RELAY_PROXY` is configured, or only warn/document the risk?
- Should the first implementation include a maximum handshake duration and maximum unauthenticated sessions as config values, or use fixed conservative defaults?
- Should the E2EE PSK also authenticate the session without a separate `RELAY_TOKEN`, or should `RELAY_TOKEN` remain a separate authorization layer inside the encrypted envelope?
