## ADDED Requirements

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
