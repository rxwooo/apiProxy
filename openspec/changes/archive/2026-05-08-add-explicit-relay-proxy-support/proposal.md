## Why

Cross-network deployments can require the local client to reach the remote WSS relay through an explicit HTTP/HTTPS proxy. Testing showed that proxied `curl` can reach the relay successfully while the Node.js local client times out, because the current WebSocket client does not explicitly use the Windows system proxy/PAC path.

## What Changes

- Add explicit outbound proxy configuration for the local relay client.
- Route local-to-remote WSS connections through the configured proxy when enabled.
- Preserve current direct connection behavior when no proxy is configured.
- Add diagnostics that make it clear whether a relay connection attempt used a proxy.
- Document Windows/PAC deployment guidance and explicit proxy configuration.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `wss-api-relay`: Add explicit local relay outbound proxy support for connecting to the remote WSS relay.

## Impact

- Updates local proxy configuration to include an optional relay proxy URL and proxy bypass behavior.
- Updates WSS client connection creation to pass an appropriate proxy agent when configured.
- Adds or updates dependencies for WebSocket-compatible HTTP/HTTPS proxy tunneling.
- Adds tests for direct connections, proxied WSS connections, invalid proxy configuration, and proxy diagnostics.
- Updates README and `.env.example` with Windows/PAC troubleshooting and explicit proxy examples.
