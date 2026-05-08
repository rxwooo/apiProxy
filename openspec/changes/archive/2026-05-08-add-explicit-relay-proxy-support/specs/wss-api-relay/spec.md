## ADDED Requirements

### Requirement: Explicit local relay outbound proxy
The local proxy SHALL support an explicitly configured outbound proxy for the WebSocket connection to the remote relay.

#### Scenario: Relay proxy is configured
- **WHEN** the local proxy starts with a valid `RELAY_PROXY` configuration
- **THEN** the local relay client MUST establish the remote relay WebSocket connection through that proxy

#### Scenario: Relay proxy is not configured
- **WHEN** the local proxy starts without `RELAY_PROXY`
- **THEN** the local relay client MUST preserve the existing direct WebSocket connection behavior

#### Scenario: Relay proxy configuration is invalid
- **WHEN** the local proxy starts with a malformed or unsupported `RELAY_PROXY` value
- **THEN** startup validation MUST reject the configuration with a clear error

#### Scenario: Relay host matches proxy bypass list
- **WHEN** `RELAY_PROXY` is configured and the relay host matches `RELAY_NO_PROXY`
- **THEN** the local relay client MUST connect directly to the relay without using the proxy

#### Scenario: Proxied relay authentication succeeds
- **WHEN** the local relay client connects through a proxy with valid relay credentials
- **THEN** the remote relay MUST receive the normal relay authentication and accept the WSS session

#### Scenario: Proxied relay connection fails
- **WHEN** the local relay client cannot establish the WebSocket connection through the configured proxy
- **THEN** the local proxy MUST return a gateway-style error and log diagnostic metadata indicating proxy mode was used

#### Scenario: Proxy URL contains credentials
- **WHEN** `RELAY_PROXY` includes username or password information
- **THEN** logs MUST redact proxy credentials while preserving non-sensitive diagnostic information such as proxy host and port
