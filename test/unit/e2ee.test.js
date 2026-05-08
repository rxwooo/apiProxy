import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalConfig, createRemoteConfig } from '../../src/shared/config.js';
import {
  E2EE_MODE_REQUIRED,
  createClientE2eeSession,
  createClientHello,
  createServerE2eeSession,
  createServerHello
} from '../../src/shared/e2ee.js';

const key = Buffer.alloc(32, 1);
const otherKey = Buffer.alloc(32, 2);
const keyB64 = key.toString('base64');

function createSessionPair({ clientKey = key, serverKey = key } = {}) {
  const { clientNonce, message: clientHello } = createClientHello({ keyId: 'main' });
  const { serverNonce, sessionId, suite, message: serverHello } = createServerHello({
    clientHello
  });
  return {
    client: createClientE2eeSession({
      keyId: 'main',
      psk: clientKey,
      clientNonce,
      serverHello
    }),
    server: createServerE2eeSession({
      keyId: 'main',
      psk: serverKey,
      clientNonce,
      serverNonce,
      sessionId,
      suite
    })
  };
}

test('E2EE sessions seal and open frames in both directions', () => {
  const { client, server } = createSessionPair();

  const sealedRequest = client.seal(Buffer.from('request secret'));
  assert.doesNotMatch(sealedRequest.toString('utf8'), /request secret/);
  assert.equal(server.open(sealedRequest).toString(), 'request secret');

  const sealedResponse = server.seal(Buffer.from('response secret'));
  assert.doesNotMatch(sealedResponse.toString('utf8'), /response secret/);
  assert.equal(client.open(sealedResponse).toString(), 'response secret');
});

test('E2EE rejects duplicate sequence numbers', () => {
  const { client, server } = createSessionPair();
  const sealed = client.seal(Buffer.from('first'));

  assert.equal(server.open(sealed).toString(), 'first');
  assert.throws(() => server.open(sealed), /Unexpected sealed frame sequence/);
});

test('E2EE rejects tampered ciphertext', () => {
  const { client, server } = createSessionPair();
  const sealed = Buffer.from(client.seal(Buffer.from('secret')));
  sealed[sealed.length - 2] ^= 0xff;

  assert.throws(() => server.open(sealed), /authentication failed/);
});

test('E2EE rejects mismatched keys', () => {
  const { client, server } = createSessionPair({ serverKey: otherKey });
  const sealed = client.seal(Buffer.from('secret'));

  assert.throws(() => server.open(sealed), /authentication failed/);
});

test('local E2EE config validates mode, key id, and PSK', () => {
  const config = createLocalConfig({
    envFile: 'missing.env',
    env: {
      RELAY_E2EE: E2EE_MODE_REQUIRED,
      RELAY_E2EE_KEY_ID: 'main',
      RELAY_E2EE_PSK_B64: keyB64
    }
  });

  assert.equal(config.relayE2eeMode, E2EE_MODE_REQUIRED);
  assert.equal(config.relayE2eeKeyId, 'main');
  assert.equal(config.relayE2eePsk.compare(key), 0);
  assert.throws(
    () =>
      createLocalConfig({
        envFile: 'missing.env',
        env: { RELAY_E2EE: 'required', RELAY_E2EE_PSK_B64: keyB64 }
      }),
    /RELAY_E2EE_KEY_ID/
  );
  assert.throws(
    () => createLocalConfig({ envFile: 'missing.env', env: { RELAY_E2EE: 'maybe' } }),
    /RELAY_E2EE must be one of/
  );
});

test('remote E2EE config validates key maps and single-key fallback', () => {
  const config = createRemoteConfig({
    envFile: 'missing.env',
    env: {
      RELAY_E2EE: E2EE_MODE_REQUIRED,
      RELAY_E2EE_KEYS_JSON: JSON.stringify({ main: keyB64 })
    }
  });

  assert.equal(config.relayE2eeMode, E2EE_MODE_REQUIRED);
  assert.equal(config.relayE2eeKeys.get('main').compare(key), 0);

  const singleKey = createRemoteConfig({
    envFile: 'missing.env',
    env: {
      RELAY_E2EE: E2EE_MODE_REQUIRED,
      RELAY_E2EE_KEY_ID: 'single',
      RELAY_E2EE_PSK_B64: keyB64
    }
  });
  assert.equal(singleKey.relayE2eeKeys.get('single').compare(key), 0);

  assert.throws(
    () =>
      createRemoteConfig({
        envFile: 'missing.env',
        env: { RELAY_E2EE: E2EE_MODE_REQUIRED, RELAY_E2EE_KEYS_JSON: '{"main":"bad"}' }
      }),
    /valid base64/
  );
});
