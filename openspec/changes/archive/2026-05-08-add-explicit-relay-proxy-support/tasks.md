## 1. Configuration

- [x] 1.1 Add `RELAY_PROXY` and `RELAY_NO_PROXY` to local configuration loading
- [x] 1.2 Validate supported proxy URL schemes and reject malformed proxy configuration at startup
- [x] 1.3 Implement relay host bypass matching for `RELAY_NO_PROXY`
- [x] 1.4 Add redacted proxy diagnostic helpers for logs and startup metadata

## 2. Relay Client Proxy Transport

- [x] 2.1 Add a WebSocket-compatible HTTP/HTTPS proxy agent dependency
- [x] 2.2 Build a proxy agent for the local relay WebSocket client when `RELAY_PROXY` is configured and not bypassed
- [x] 2.3 Preserve existing direct WebSocket behavior when no proxy is configured or bypass applies
- [x] 2.4 Ensure relay authentication headers are still sent to the remote relay over proxied connections
- [x] 2.5 Include proxy mode diagnostics in connection success and failure logs without leaking credentials

## 3. Tests

- [x] 3.1 Add unit tests for proxy configuration parsing and invalid proxy values
- [x] 3.2 Add unit tests for `RELAY_NO_PROXY` host and suffix matching
- [x] 3.3 Add unit tests for proxy diagnostic redaction
- [x] 3.4 Add integration test for direct relay connection behavior remaining unchanged
- [x] 3.5 Add integration test that connects to the remote relay through a local HTTP CONNECT proxy
- [x] 3.6 Add integration test for proxied relay authentication and error reporting

## 4. Documentation

- [x] 4.1 Update `.env.example` with `RELAY_PROXY` and `RELAY_NO_PROXY`
- [x] 4.2 Update README with Windows system proxy/PAC guidance and explicit proxy examples
- [x] 4.3 Document manual verification commands for direct versus explicit proxy access
