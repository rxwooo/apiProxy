## 1. Configuration and Protocol Foundation

- [x] 1.1 Add E2EE configuration parsing for local and remote modes, local key id, local PSK, and remote key map.
- [x] 1.2 Add startup validation for invalid E2EE modes, missing keys, invalid base64 keys, and production-required combinations.
- [x] 1.3 Add relay protocol message types and helpers for E2EE client hello, server hello, session auth, acknowledgements, and sealed frames.
- [x] 1.4 Add a shared E2EE envelope module using HKDF-SHA256, AES-256-GCM, per-direction keys, sequence-derived nonces, and authenticated associated data.
- [x] 1.5 Add unit tests for key derivation, seal/open round trips, sequence rejection, tamper rejection, key mismatch failure, and config validation.

## 2. Local Relay Client Integration

- [x] 2.1 Update the local relay client to choose plaintext or E2EE mode once per WebSocket session from configuration.
- [x] 2.2 Implement the local E2EE handshake and encrypted session authentication before relaying requests.
- [x] 2.3 Prevent the local relay client from sending the relay token in the WebSocket upgrade `Authorization` header when E2EE is required.
- [x] 2.4 Wrap all outbound request, chunk, end, cancel, and ping messages in sealed frames after E2EE is established.
- [x] 2.5 Unwrap all inbound response, chunk, end, error, ack, and pong messages before passing them to existing relay handlers.
- [x] 2.6 Return gateway-style failures when required E2EE cannot be established, without sending plaintext relay data.

## 3. Remote Relay Integration

- [x] 3.1 Update WebSocket upgrade handling so E2EE-required sessions can upgrade without plaintext relay token exposure.
- [x] 3.2 Add a short unauthenticated E2EE handshake timeout before request relay messages are accepted.
- [x] 3.3 Implement remote E2EE client hello handling, key lookup by key id, server hello generation, and encrypted session auth validation.
- [x] 3.4 Unwrap encrypted inbound relay messages and route plaintext to the existing request reassembly and forwarding handlers.
- [x] 3.5 Wrap outbound response metadata, response chunks, response end, relay errors, and acknowledgements in sealed frames for encrypted sessions.
- [x] 3.6 Reject plaintext relay messages, unsupported suites, invalid keys, invalid encrypted auth, and downgrade attempts when E2EE is required.

## 4. Integration Coverage

- [x] 4.1 Preserve existing integration behavior with E2EE disabled.
- [x] 4.2 Add integration tests for non-streaming chat completions over E2EE-required relay sessions.
- [x] 4.3 Add integration tests for streaming chat completions over E2EE-required relay sessions.
- [x] 4.4 Add integration tests showing observed WebSocket frames do not contain request paths, prompts, relay tokens, response headers, or response bodies in plaintext.
- [x] 4.5 Add integration tests for invalid E2EE key material, invalid encrypted relay token, missing handshake, and plaintext relay message rejection.
- [x] 4.6 Add integration tests for remote multi-key rotation using the local key id.

## 5. Documentation and Verification

- [x] 5.1 Document E2EE configuration, key generation, required mode, optional rollout, and relay token rotation guidance in README.
- [x] 5.2 Update `.env.example` with E2EE variables and safe comments.
- [x] 5.3 Run `npm test` and fix any regressions.
- [x] 5.4 Run `openspec status --change add-relay-e2ee-envelope` and confirm the change is apply-ready.
