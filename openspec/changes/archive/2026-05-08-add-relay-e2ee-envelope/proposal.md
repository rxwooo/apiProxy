## Why

The local proxy may need to reach the remote relay through an enterprise HTTP proxy that performs HTTPS inspection. In that environment, WSS/TLS no longer provides end-to-end confidentiality between the local proxy and remote relay, so prompt data, headers, and model responses need an application-layer encryption envelope.

## What Changes

- Add an end-to-end encrypted relay envelope between the local proxy and remote relay.
- Add a session handshake that derives per-session encryption keys from a configured pre-shared key and fresh client/server nonces.
- Encrypt relay protocol messages after the handshake so intermediaries can only observe connection metadata and ciphertext.
- Move sensitive relay authentication inside the encrypted envelope when E2EE is enabled.
- Add fail-closed production behavior so E2EE-required deployments reject plaintext or downgrade attempts.
- Add configuration for E2EE mode, key id, and one or more pre-shared keys for key rotation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wss-api-relay`: Require optional or mandatory application-layer end-to-end encryption for relay sessions that traverse inspectable proxy infrastructure.

## Impact

- Local relay client: E2EE handshake, encrypted frame wrapping, encrypted authentication, and encrypted response handling.
- Remote relay server: E2EE handshake validation, key lookup, encrypted frame unwrapping, encrypted response wrapping, and plaintext rejection when required.
- Shared relay protocol: new E2EE handshake messages and sealed frame format.
- Shared configuration: E2EE mode, key id, PSK parsing, multi-key support, and production validation.
- Tests: unit coverage for cryptographic envelope behavior and integration coverage for encrypted relay requests, proxy-visible ciphertext, downgrade rejection, and key mismatch failure.
