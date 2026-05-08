import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalConfig } from '../../src/shared/config.js';
import {
  getRelayProxyDiagnostics,
  getRelayProxyUrl,
  parseRelayNoProxy,
  parseRelayProxy,
  shouldBypassRelayProxy
} from '../../src/shared/proxy.js';

test('parseRelayProxy accepts explicit http and https proxy URLs', () => {
  assert.equal(parseRelayProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(parseRelayProxy('https://proxy.example.com'), 'https://proxy.example.com/');
});

test('parseRelayProxy rejects malformed and unsupported proxy URLs', () => {
  assert.throws(() => parseRelayProxy('not a url'), /valid URL/);
  assert.throws(() => parseRelayProxy('socks5://127.0.0.1:1080'), /http:\/\/ or https:\/\//);
});

test('createLocalConfig loads relay proxy and bypass configuration', () => {
  const config = createLocalConfig({
    env: {
      RELAY_URL: 'wss://relay.example.com/relay',
      RELAY_PROXY: 'http://127.0.0.1:7890',
      RELAY_NO_PROXY: 'localhost, .internal'
    },
    envFile: 'missing.env'
  });

  assert.equal(config.relayProxy, 'http://127.0.0.1:7890/');
  assert.deepEqual(config.relayNoProxy, ['localhost', '.internal']);
  assert.equal(config.relayProxyDiagnostics.relayProxyEnabled, true);
  assert.equal(config.relayProxyDiagnostics.relayProxyHost, '127.0.0.1:7890');
});

test('parseRelayNoProxy trims empty entries', () => {
  assert.deepEqual(parseRelayNoProxy(' localhost, , .example.com '), [
    'localhost',
    '.example.com'
  ]);
});

test('shouldBypassRelayProxy matches exact hosts, ports, wildcard, and suffixes', () => {
  assert.equal(shouldBypassRelayProxy('wss://relay.example.com/relay', ['relay.example.com']), true);
  assert.equal(
    shouldBypassRelayProxy('wss://relay.example.com:9999/relay', ['relay.example.com:9999']),
    true
  );
  assert.equal(shouldBypassRelayProxy('wss://relay.example.com/relay', ['.example.com']), true);
  assert.equal(shouldBypassRelayProxy('wss://relay.example.com/relay', ['*.example.com']), true);
  assert.equal(shouldBypassRelayProxy('wss://relay.example.com/relay', ['*']), true);
  assert.equal(shouldBypassRelayProxy('wss://relay.example.com/relay', ['other.example.com']), false);
});

test('getRelayProxyUrl returns empty when no proxy is configured or bypass applies', () => {
  assert.equal(getRelayProxyUrl({ relayUrl: 'wss://relay.example.com/relay' }), '');
  assert.equal(
    getRelayProxyUrl({
      relayUrl: 'wss://relay.example.com/relay',
      relayProxy: 'http://127.0.0.1:7890/',
      relayNoProxy: ['.example.com']
    }),
    ''
  );
});

test('getRelayProxyDiagnostics does not expose proxy credentials', () => {
  const diagnostics = getRelayProxyDiagnostics({
    relayUrl: 'wss://relay.example.com/relay',
    relayProxy: 'http://user:secret@127.0.0.1:7890/',
    relayNoProxy: []
  });

  assert.equal(diagnostics.relayProxyConfigured, true);
  assert.equal(diagnostics.relayProxyEnabled, true);
  assert.equal(diagnostics.relayProxyHost, '127.0.0.1:7890');
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|user/);
});
