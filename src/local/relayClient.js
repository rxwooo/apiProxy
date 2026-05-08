import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { splitBuffer, sha256Hex, createRequestId } from '../shared/chunking.js';
import {
  E2EE_MODE_OFF,
  createClientE2eeSession,
  createClientHello
} from '../shared/e2ee.js';
import { getRelayProxyDiagnostics, getRelayProxyUrl } from '../shared/proxy.js';
import {
  MESSAGE_TYPES,
  decodeChunkMessage,
  decodeJsonMessage,
  encodeChunkMessage,
  encodeJsonMessage
} from '../shared/protocol.js';

export class RelayUnavailableError extends Error {
  constructor(message = 'Relay connection is unavailable', metadata = {}) {
    super(message);
    this.name = 'RelayUnavailableError';
    this.code = 'RELAY_UNAVAILABLE';
    this.status = 502;
    Object.assign(this, metadata);
  }
}

export class RelayTimeoutError extends Error {
  constructor(message = 'Relay request timed out') {
    super(message);
    this.name = 'RelayTimeoutError';
    this.code = 'RELAY_TIMEOUT';
    this.status = 504;
  }
}

export class RelayResponseError extends Error {
  constructor(message, { code = 'RELAY_ERROR', status = 502 } = {}) {
    super(message);
    this.name = 'RelayResponseError';
    this.code = code;
    this.status = status;
  }
}

export class RelayClient {
  constructor(
    config,
    {
      logger,
      WebSocketClass = WebSocket,
      proxyAgentFactory = (proxyUrl) => new HttpsProxyAgent(proxyUrl)
    } = {}
  ) {
    this.config = config;
    this.logger = logger;
    this.WebSocketClass = WebSocketClass;
    this.proxyDiagnostics = getRelayProxyDiagnostics(config);
    this.proxyUrl = getRelayProxyUrl(config);
    this.proxyAgent = this.proxyUrl ? proxyAgentFactory(this.proxyUrl) : undefined;
    this.ws = undefined;
    this.e2eeSession = undefined;
    this.connectPromise = undefined;
    this.heartbeatTimer = undefined;
    this.pending = new Map();
  }

  async relayRequest({
    method,
    path,
    headers = {},
    body = Buffer.alloc(0),
    stream = false,
    signal,
    onResponseStart,
    onResponseChunk
  }) {
    const ws = await this.connect();
    const id = createRequestId();
    const payload = Buffer.from(body);
    const chunks = splitBuffer(payload, this.config.chunkSize);
    const digest = sha256Hex(payload);

    let abortListener;
    const promise = new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#sendCancel(id, 'timeout');
        this.#rejectPending(pending, new RelayTimeoutError());
      }, this.config.requestTimeoutMs);

      const pending = {
        id,
        resolve,
        reject,
        timeout,
        status: 502,
        headers: {},
        chunks: [],
        onResponseStart,
        onResponseChunk,
        responseStarted: false
      };
      this.pending.set(id, pending);

      abortListener = () => {
        this.#sendCancel(id, 'client_abort');
        this.#rejectPending(
          pending,
          new RelayResponseError('Relay request was cancelled', {
            code: 'CLIENT_ABORT',
            status: 499
          })
        );
      };
      signal?.addEventListener('abort', abortListener, { once: true });

      try {
        await this.#sendJson({
          type: MESSAGE_TYPES.REQUEST_START,
          id,
          method,
          path,
          headers,
          stream,
          encoding: 'identity',
          totalBytes: payload.length
        });

        for (let seq = 0; seq < chunks.length; seq += 1) {
          if (signal?.aborted) throw new RelayResponseError('Relay request was cancelled', {
            code: 'CLIENT_ABORT',
            status: 499
          });
          await this.#sendBinary(
            encodeChunkMessage({ type: MESSAGE_TYPES.REQUEST_CHUNK, id, seq }, chunks[seq])
          );
        }

        await this.#sendJson({
          type: MESSAGE_TYPES.REQUEST_END,
          id,
          chunks: chunks.length,
          sha256: digest
        });
      } catch (error) {
        this.#rejectPending(pending, error);
      }
    });

    try {
      return await promise;
    } finally {
      signal?.removeEventListener('abort', abortListener);
    }
  }

  async connect() {
    if (this.ws?.readyState === this.WebSocketClass.OPEN) return this.ws;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      const useE2ee = this.#e2eeMode() !== E2EE_MODE_OFF;
      const headers = !useE2ee && this.config.relayToken
        ? { authorization: `Bearer ${this.config.relayToken}` }
        : {};
      const ws = new this.WebSocketClass(this.config.relayUrl, {
        headers,
        ...(this.proxyAgent ? { agent: this.proxyAgent } : {})
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(this.#relayUnavailable('Relay connection timed out'));
      }, this.config.connectTimeoutMs);

      const rejectOnce = (error) => {
        clearTimeout(timeout);
        reject(
          error instanceof RelayUnavailableError
            ? error
            : this.#relayUnavailable(error instanceof Error ? error.message : String(error))
        );
      };

      ws.once('open', () => {
        Promise.resolve()
          .then(async () => {
            this.e2eeSession = await this.#establishE2ee(ws);
            clearTimeout(timeout);
            this.ws = ws;
            this.#attachSocket(ws);
            this.#startHeartbeat();
            this.logger?.info('relay_connected', {
              relayUrl: this.config.relayUrl,
              relayE2eeMode: this.#e2eeMode(),
              relayE2eeEnabled: Boolean(this.e2eeSession),
              ...this.proxyDiagnostics
            });
            resolve(ws);
          })
          .catch((error) => {
            ws.terminate();
            rejectOnce(error);
          });
      });
      ws.once('error', rejectOnce);
      ws.once('close', (code, reason) => {
        if (this.ws !== ws) {
          rejectOnce(this.#relayUnavailable(`Relay closed: ${code} ${reason}`));
        }
      });
    }).finally(() => {
      this.connectPromise = undefined;
    });

    return this.connectPromise;
  }

  async close() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new RelayUnavailableError('Relay client is closing'));
    }
    this.pending.clear();
    if (this.ws && this.ws.readyState === this.WebSocketClass.OPEN) {
      await new Promise((resolve) => {
        this.ws.once('close', resolve);
        this.ws.close();
      });
    }
    this.ws = undefined;
    this.e2eeSession = undefined;
  }

  #attachSocket(ws) {
    ws.on('message', (data, isBinary) => {
      try {
        this.#handleFrame(data, isBinary);
      } catch (error) {
        this.logger?.warn('relay_message_error', {
          code: error.code,
          message: error.message
        });
      }
    });

    ws.on('close', (code, reason) => {
      this.logger?.warn('relay_disconnected', {
        code,
        reason: reason.toString(),
        ...this.proxyDiagnostics
      });
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      if (this.ws === ws) {
        this.ws = undefined;
        this.e2eeSession = undefined;
      }
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(this.#relayUnavailable('Relay connection closed'));
      }
      this.pending.clear();
    });

    ws.on('error', (error) => {
      this.logger?.warn('relay_socket_error', {
        message: error.message,
        ...this.proxyDiagnostics
      });
    });
  }

  #relayUnavailable(message) {
    return new RelayUnavailableError(message, this.proxyDiagnostics);
  }

  #e2eeMode() {
    return this.config.relayE2eeMode ?? E2EE_MODE_OFF;
  }

  async #establishE2ee(ws) {
    if (this.#e2eeMode() === E2EE_MODE_OFF) return undefined;
    if (!this.config.relayE2eeKeyId || !this.config.relayE2eePsk) {
      throw this.#relayUnavailable('Relay E2EE is enabled but key configuration is incomplete');
    }

    const { clientNonce, message } = createClientHello({
      keyId: this.config.relayE2eeKeyId
    });
    await sendWsRaw(ws, encodeJsonMessage(message));

    const serverHelloFrame = await readWsMessage(ws);
    if (serverHelloFrame.isBinary) {
      throw this.#relayUnavailable('Relay E2EE handshake returned an unexpected binary frame');
    }

    const serverHello = decodeJsonMessage(serverHelloFrame.data);
    if (serverHello.type === MESSAGE_TYPES.ERROR) {
      throw this.#relayUnavailable(serverHello.message ?? 'Relay E2EE handshake failed');
    }
    if (serverHello.type !== MESSAGE_TYPES.E2EE_SERVER_HELLO) {
      throw this.#relayUnavailable('Relay did not complete the E2EE handshake');
    }

    const session = createClientE2eeSession({
      keyId: this.config.relayE2eeKeyId,
      psk: this.config.relayE2eePsk,
      clientNonce,
      serverHello
    });

    await sendWsRaw(
      ws,
      session.seal(
        encodeJsonMessage({
          type: MESSAGE_TYPES.E2EE_SESSION_AUTH,
          relayToken: this.config.relayToken ?? '',
          keyId: this.config.relayE2eeKeyId,
          mode: this.#e2eeMode()
        })
      ),
      { binary: true }
    );

    const ackFrame = await readWsMessage(ws);
    if (!ackFrame.isBinary) {
      throw this.#relayUnavailable('Relay E2EE authentication returned plaintext');
    }
    const ack = decodeJsonMessage(session.open(ackFrame.data));
    if (ack.type === MESSAGE_TYPES.ERROR) {
      throw this.#relayUnavailable(ack.message ?? 'Relay E2EE authentication failed');
    }
    if (ack.type !== MESSAGE_TYPES.ACK) {
      throw this.#relayUnavailable('Relay E2EE authentication did not acknowledge the session');
    }

    return session;
  }

  #startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === this.WebSocketClass.OPEN) {
        this.ws.ping();
      }
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  #handleJson(message) {
    if (message.type === MESSAGE_TYPES.RESPONSE_START) {
      const pending = this.#pending(message.id);
      pending.status = message.status;
      pending.headers = message.headers ?? {};
      pending.responseStarted = true;
      pending.onResponseStart?.({
        status: pending.status,
        headers: pending.headers,
        stream: Boolean(message.stream)
      });
      return;
    }

    if (message.type === MESSAGE_TYPES.RESPONSE_END) {
      const pending = this.#pending(message.id);
      this.#resolvePending(pending, {
        status: pending.status,
        headers: pending.headers,
        body: Buffer.concat(pending.chunks)
      });
      return;
    }

    if (message.type === MESSAGE_TYPES.ERROR) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.#rejectPending(
          pending,
          new RelayResponseError(message.message, {
            code: message.code,
            status: message.status
          })
        );
      }
      return;
    }

    if (message.type === MESSAGE_TYPES.PONG || message.type === MESSAGE_TYPES.ACK) return;
  }

  #handleFrame(data, isBinary) {
    if (this.e2eeSession) {
      if (!isBinary) {
        throw new RelayResponseError('Encrypted relay session received plaintext frame', {
          code: 'E2EE_PLAINTEXT_FRAME',
          status: 502
        });
      }
      const plaintext = this.e2eeSession.open(data);
      if (isJsonFrame(plaintext)) {
        this.#handleJson(decodeJsonMessage(plaintext));
      } else {
        this.#handleBinary(plaintext);
      }
      return;
    }

    if (isBinary) {
      this.#handleBinary(data);
    } else {
      this.#handleJson(decodeJsonMessage(data));
    }
  }

  #handleBinary(data) {
    const { header, payload } = decodeChunkMessage(data);
    if (header.type !== MESSAGE_TYPES.RESPONSE_CHUNK) return;

    const pending = this.#pending(header.id);
    if (pending.onResponseChunk) {
      pending.onResponseChunk(payload);
    } else {
      pending.chunks.push(payload);
    }
  }

  #pending(id) {
    const pending = this.pending.get(id);
    if (!pending) throw new RelayResponseError('Unknown response id', { code: 'UNKNOWN_RESPONSE' });
    return pending;
  }

  #resolvePending(pending, result) {
    clearTimeout(pending.timeout);
    this.pending.delete(pending.id);
    pending.resolve(result);
  }

  #rejectPending(pending, error) {
    clearTimeout(pending.timeout);
    this.pending.delete(pending.id);
    pending.reject(error);
  }

  async #sendJson(message) {
    return this.#sendRaw(encodeJsonMessage(message));
  }

  async #sendBinary(frame) {
    return this.#sendRaw(frame, { binary: true });
  }

  async #sendCancel(id, reason) {
    try {
      await this.#sendJson({ type: MESSAGE_TYPES.REQUEST_CANCEL, id, reason });
    } catch {
      // Best-effort cancellation.
    }
  }

  async #sendRaw(data, options = {}) {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WebSocketClass.OPEN) {
      throw new RelayUnavailableError();
    }

    const payload = this.e2eeSession ? this.e2eeSession.seal(data) : data;
    const sendOptions = this.e2eeSession ? { binary: true } : options;
    await new Promise((resolve, reject) => {
      ws.send(payload, sendOptions, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function isJsonFrame(data) {
  const buffer = Buffer.from(data);
  return buffer.length > 0 && buffer[0] === 0x7b;
}

async function sendWsRaw(ws, data, options = {}) {
  await new Promise((resolve, reject) => {
    ws.send(data, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readWsMessage(ws) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
    const onMessage = (data, isBinary) => {
      cleanup();
      resolve({ data, isBinary });
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`Relay closed during E2EE handshake: ${code} ${reason}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    ws.once('message', onMessage);
    ws.once('close', onClose);
    ws.once('error', onError);
  });
}
