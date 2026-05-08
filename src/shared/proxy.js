const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:']);

export function parseRelayProxy(raw = '') {
  if (!raw) return '';

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RELAY_PROXY must be a valid URL');
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error('RELAY_PROXY must use http:// or https://');
  }
  if (!url.hostname) {
    throw new Error('RELAY_PROXY must include a hostname');
  }

  return url.toString();
}

export function parseRelayNoProxy(raw = '') {
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function shouldBypassRelayProxy(relayUrl, relayNoProxy = []) {
  if (!relayNoProxy.length) return false;

  const url = new URL(relayUrl);
  const host = normalizeHost(url.hostname);
  const hostWithPort = `${host}:${url.port || defaultPort(url.protocol)}`;

  return relayNoProxy.some((entry) => matchesNoProxyEntry(host, hostWithPort, entry));
}

export function getRelayProxyDiagnostics({ relayUrl, relayProxy = '', relayNoProxy = [] }) {
  const proxyConfigured = Boolean(relayProxy);
  const bypassed = proxyConfigured && shouldBypassRelayProxy(relayUrl, relayNoProxy);
  const diagnostics = {
    relayProxyConfigured: proxyConfigured,
    relayProxyEnabled: proxyConfigured && !bypassed,
    relayProxyBypassed: Boolean(bypassed)
  };

  if (proxyConfigured) {
    diagnostics.relayProxyHost = proxyHostLabel(relayProxy);
  }

  return diagnostics;
}

export function getRelayProxyUrl({ relayUrl, relayProxy = '', relayNoProxy = [] }) {
  if (!relayProxy) return '';
  return shouldBypassRelayProxy(relayUrl, relayNoProxy) ? '' : relayProxy;
}

export function proxyHostLabel(proxyUrl) {
  const url = new URL(proxyUrl);
  return `${normalizeHost(url.hostname)}:${url.port || defaultPort(url.protocol)}`;
}

function matchesNoProxyEntry(host, hostWithPort, entry) {
  if (entry === '*') return true;
  if (entry === host || entry === hostWithPort) return true;

  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1);
    return host.endsWith(suffix);
  }

  if (entry.startsWith('.')) {
    const domain = entry.slice(1);
    return host === domain || host.endsWith(entry);
  }

  return false;
}

function normalizeHost(host) {
  return host.toLowerCase().replace(/^\[(.*)]$/, '$1');
}

function defaultPort(protocol) {
  if (protocol === 'wss:' || protocol === 'https:') return '443';
  if (protocol === 'ws:' || protocol === 'http:') return '80';
  return '';
}
