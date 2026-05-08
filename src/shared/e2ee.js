import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes
} from 'node:crypto';
import {
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeSealedFrame,
  encodeSealedFrame
} from './protocol.js';

export const E2EE_MODES = Object.freeze(['off', 'optional', 'required']);
export const E2EE_MODE_OFF = 'off';
export const E2EE_MODE_OPTIONAL = 'optional';
export const E2EE_MODE_REQUIRED = 'required';
export const E2EE_SUITE = 'psk-hkdf-sha256-aes-256-gcm';
export const MIN_E2EE_PSK_BYTES = 32;
export const E2EE_HANDSHAKE_TIMEOUT_MS = 5000;

const NONCE_BYTES = 32;
const SESSION_ID_BYTES = 16;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const GCM_IV_BYTES = 12;
const CIPHER = 'aes-256-gcm';
const DIRECTION_CLIENT_TO_SERVER = 'c2s';
const DIRECTION_SERVER_TO_CLIENT = 's2c';

export function decodeBase64Secret(raw, name = 'E2EE key') {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`${name} must be base64 encoded`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error(`${name} must be valid base64`);
  }

  const decoded = Buffer.from(value, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  const input = value.replace(/=+$/, '');
  if (!decoded.length || canonical !== input) {
    throw new Error(`${name} must be valid base64`);
  }
  if (decoded.length < MIN_E2EE_PSK_BYTES) {
    throw new Error(`${name} must decode to at least ${MIN_E2EE_PSK_BYTES} bytes`);
  }
  return decoded;
}

export function createClientHello({ keyId, randomBytesFn = randomBytes }) {
  if (!keyId) throw new ProtocolError('E2EE key id is required', { code: 'E2EE_MISSING_KEY_ID' });
  const clientNonce = randomBytesFn(NONCE_BYTES).toString('base64');
  return {
    clientNonce,
    message: {
      type: MESSAGE_TYPES.E2EE_CLIENT_HELLO,
      keyId,
      clientNonce,
      suites: [E2EE_SUITE]
    }
  };
}

export function createServerHello({ clientHello, randomBytesFn = randomBytes }) {
  const suite = selectSuite(clientHello.suites);
  const serverNonce = randomBytesFn(NONCE_BYTES).toString('base64');
  const sessionId = randomBytesFn(SESSION_ID_BYTES).toString('base64url');
  return {
    serverNonce,
    sessionId,
    suite,
    message: {
      type: MESSAGE_TYPES.E2EE_SERVER_HELLO,
      sessionId,
      serverNonce,
      suite
    }
  };
}

export function createClientE2eeSession({ keyId, psk, clientNonce, serverHello }) {
  const keys = deriveSessionKeys({
    keyId,
    psk,
    clientNonce,
    serverNonce: serverHello.serverNonce,
    sessionId: serverHello.sessionId,
    suite: serverHello.suite
  });
  return new E2EESession({
    sessionId: serverHello.sessionId,
    sendKey: keys.clientToServerKey,
    receiveKey: keys.serverToClientKey,
    sendDirection: DIRECTION_CLIENT_TO_SERVER,
    receiveDirection: DIRECTION_SERVER_TO_CLIENT
  });
}

export function createServerE2eeSession({
  keyId,
  psk,
  clientNonce,
  serverNonce,
  sessionId,
  suite
}) {
  const keys = deriveSessionKeys({ keyId, psk, clientNonce, serverNonce, sessionId, suite });
  return new E2EESession({
    sessionId,
    sendKey: keys.serverToClientKey,
    receiveKey: keys.clientToServerKey,
    sendDirection: DIRECTION_SERVER_TO_CLIENT,
    receiveDirection: DIRECTION_CLIENT_TO_SERVER
  });
}

export function deriveSessionKeys({ keyId, psk, clientNonce, serverNonce, sessionId, suite }) {
  if (suite !== E2EE_SUITE) {
    throw new ProtocolError('Unsupported E2EE suite', { code: 'UNSUPPORTED_E2EE_SUITE' });
  }
  const pskBytes = Buffer.from(psk);
  if (pskBytes.length < MIN_E2EE_PSK_BYTES) {
    throw new ProtocolError('E2EE key is too short', { code: 'E2EE_KEY_TOO_SHORT' });
  }

  const transcript = transcriptHash({ keyId, clientNonce, serverNonce, sessionId, suite });
  const salt = createHash('sha256')
    .update(Buffer.from(clientNonce, 'base64'))
    .update(Buffer.from(serverNonce, 'base64'))
    .update(transcript)
    .digest();
  const sessionSecret = hkdf(pskBytes, salt, Buffer.from(`relay-e2ee session ${suite}`), KEY_BYTES);

  return {
    clientToServerKey: hkdf(
      sessionSecret,
      Buffer.from(sessionId),
      Buffer.from(`relay-e2ee c2s ${transcript.toString('hex')}`),
      KEY_BYTES
    ),
    serverToClientKey: hkdf(
      sessionSecret,
      Buffer.from(sessionId),
      Buffer.from(`relay-e2ee s2c ${transcript.toString('hex')}`),
      KEY_BYTES
    )
  };
}

export class E2EESession {
  constructor({ sessionId, sendKey, receiveKey, sendDirection, receiveDirection }) {
    this.sessionId = sessionId;
    this.sendKey = Buffer.from(sendKey);
    this.receiveKey = Buffer.from(receiveKey);
    this.sendDirection = sendDirection;
    this.receiveDirection = receiveDirection;
    this.sendSeq = 0;
    this.receiveSeq = 0;
  }

  seal(plaintext) {
    const seq = this.sendSeq;
    if (!Number.isSafeInteger(seq)) {
      throw new ProtocolError('E2EE send sequence exhausted', { code: 'E2EE_SEQUENCE_EXHAUSTED' });
    }
    const iv = frameNonce({ sessionId: this.sessionId, direction: this.sendDirection, seq });
    const aad = frameAad({ sessionId: this.sessionId, direction: this.sendDirection, seq });
    const cipher = createCipheriv(CIPHER, this.sendKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
    this.sendSeq += 1;
    return encodeSealedFrame({ sessionId: this.sessionId, seq }, payload);
  }

  open(frame) {
    const { header, payload } = decodeSealedFrame(frame);
    if (header.sessionId !== this.sessionId) {
      throw new ProtocolError('Sealed frame session id mismatch', {
        code: 'E2EE_SESSION_MISMATCH'
      });
    }
    if (header.seq !== this.receiveSeq) {
      throw new ProtocolError('Unexpected sealed frame sequence', {
        code: 'E2EE_SEQUENCE_MISMATCH'
      });
    }
    if (payload.length < TAG_BYTES) {
      throw new ProtocolError('Sealed frame payload is too short', { code: 'E2EE_INVALID_FRAME' });
    }

    const ciphertext = payload.subarray(0, payload.length - TAG_BYTES);
    const tag = payload.subarray(payload.length - TAG_BYTES);
    const iv = frameNonce({
      sessionId: this.sessionId,
      direction: this.receiveDirection,
      seq: header.seq
    });
    const aad = frameAad({
      sessionId: this.sessionId,
      direction: this.receiveDirection,
      seq: header.seq
    });

    try {
      const decipher = createDecipheriv(CIPHER, this.receiveKey, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      this.receiveSeq += 1;
      return plaintext;
    } catch {
      throw new ProtocolError('Sealed frame authentication failed', {
        code: 'E2EE_AUTH_FAILED'
      });
    }
  }
}

function selectSuite(suites = []) {
  if (Array.isArray(suites) && suites.includes(E2EE_SUITE)) return E2EE_SUITE;
  throw new ProtocolError('Unsupported E2EE suite', { code: 'UNSUPPORTED_E2EE_SUITE' });
}

function hkdf(ikm, salt, info, length) {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

function transcriptHash({ keyId, clientNonce, serverNonce, sessionId, suite }) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        keyId,
        clientNonce,
        serverNonce,
        sessionId,
        suite
      })
    )
    .digest();
}

function frameNonce({ sessionId, direction, seq }) {
  const iv = Buffer.alloc(GCM_IV_BYTES);
  createHash('sha256')
    .update(`${sessionId}:${direction}`)
    .digest()
    .subarray(0, 4)
    .copy(iv, 0);
  iv.writeBigUInt64BE(BigInt(seq), 4);
  return iv;
}

function frameAad({ sessionId, direction, seq }) {
  return Buffer.from(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      type: MESSAGE_TYPES.SEALED,
      sessionId,
      direction,
      seq
    })
  );
}
