## Context

The local proxy currently creates a direct WebSocket connection to the remote relay. On Windows deployments that use a system proxy script or PAC configuration, browser and proxied `curl` traffic can reach the relay while the Node.js `ws` client times out, because it does not automatically inherit that system proxy path.

The fix is to add an explicit proxy option for the local relay client:

```text
Local Proxy
  | WSS via configured HTTP/HTTPS proxy tunnel
  v
Corporate/VPN/Local Proxy
  | WSS
  v
Remote Relay
```

## Goals / Non-Goals

**Goals:**

- Allow the local relay client to connect to `ws://` or `wss://` relay URLs through an explicitly configured HTTP/HTTPS proxy.
- Preserve direct connection behavior when no proxy is configured.
- Provide clear startup and failure diagnostics showing whether the relay connection is direct or proxied.
- Keep relay authentication and application protocol behavior unchanged.
- Document Windows system proxy/PAC limitations and the explicit configuration path.

**Non-Goals:**

- Automatically parsing Windows PAC scripts or browser proxy settings.
- Implementing SOCKS proxy support in the first version.
- Proxying the local agent-to-local-proxy HTTP traffic.
- Changing the remote relay server or upstream model API forwarding behavior.

## Decisions

### Add explicit local-only proxy configuration

The local configuration will add:

- `RELAY_PROXY`: optional proxy URL used only for the local proxy's outbound WSS connection to the remote relay.
- `RELAY_NO_PROXY`: optional comma-separated bypass list for relay hostnames or suffixes.

When `RELAY_PROXY` is empty, the relay client continues to connect directly. When configured and not bypassed, the relay client creates the WebSocket with a proxy agent.

Alternative considered: automatically read Windows system proxy/PAC settings. That is more convenient, but PAC evaluation is platform-specific and can hide important deployment behavior. Explicit configuration is easier to test, document, and support.

### Use a WebSocket-compatible proxy agent dependency

The implementation will use a maintained proxy agent package that works with the `ws` client. For `wss://` relay URLs over an HTTP/HTTPS proxy, the agent must establish a CONNECT tunnel and then let WebSocket/TLS negotiation proceed through that tunnel.

Alternative considered: implement CONNECT tunneling manually. That increases protocol and TLS risk without adding meaningful value, so a battle-tested dependency is preferred.

### Keep proxy credentials in the proxy URL

Proxy authentication will use standard proxy URL syntax:

```text
RELAY_PROXY=http://user:password@127.0.0.1:7890
```

Logs must redact the proxy URL or at least its credentials. Startup diagnostics can report whether proxy mode is enabled and the proxy host, but not username/password.

Alternative considered: separate `RELAY_PROXY_USER` and `RELAY_PROXY_PASSWORD` variables. That is more verbose and does not map as cleanly to existing proxy tooling.

### Fail fast on invalid proxy configuration

Startup validation will reject malformed `RELAY_PROXY` values and unsupported schemes. Supported schemes for this change are `http://` and `https://`.

Alternative considered: defer proxy errors until first request. That delays feedback and makes Windows deployment debugging harder.

### Add targeted proxy diagnostics

The local proxy should log:

- `relayProxyEnabled`: whether a proxy will be used for the relay connection.
- `relayProxyHost`: proxy hostname and port when available, without credentials.
- Failure message from WebSocket connection errors without redacting diagnostic `message`.

This complements the existing relay availability errors and helps distinguish direct network failures from proxy configuration failures.

## Risks / Trade-offs

- Proxy supports HTTPS requests but blocks WebSocket CONNECT -> document the WebSocket upgrade test and surface the upstream handshake error.
- Proxy requires authentication -> support credentials in `RELAY_PROXY` and redact credentials in logs.
- PAC script chooses different proxies by destination -> require users to convert the working route into an explicit `RELAY_PROXY` value for this tool.
- Non-standard relay ports may be blocked by proxy policy -> recommend using `wss://host/relay` on port 443 where possible.
- Additional dependency increases package surface -> choose a narrow, maintained agent dependency and cover it with integration tests.

## Migration Plan

1. Add proxy configuration fields with direct connection as the default.
2. Add the proxy agent dependency and inject it into the existing local relay WebSocket creation path.
3. Add unit tests for config parsing, bypass matching, and redacted diagnostics.
4. Add integration tests that run a local HTTP CONNECT proxy in front of the remote relay.
5. Document Windows/PAC behavior and explicit `RELAY_PROXY` usage in README and `.env.example`.
6. Roll back by unsetting `RELAY_PROXY`.

## Open Questions

- Should SOCKS proxy support be added later for users whose proxy tool only exposes SOCKS ports?
- Should a future change evaluate PAC files directly, or is explicit proxy configuration sufficient for the supported deployment model?
