import WebSocket from 'ws';
import { splitBuffer, sha256Hex, createRequestId } from '../shared/chunking.js';
import {
  MESSAGE_TYPES,
  decodeChunkMessage,
  decodeJsonMessage,
  encodeChunkMessage,
  encodeJsonMessage
} from '../shared/protocol.js';

export class RelayUnavailableError extends Error {
  constructor(message = 'Relay connection is unavailable') {
    super(message);
    this.name = 'RelayUnavailableError';
    this.code = 'RELAY_UNAVAILABLE';
    this.status = 502;
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
  constructor(config, { logger, WebSocketClass = WebSocket } = {}) {
    this.config = config;
    this.logger = logger;
    this.WebSocketClass = WebSocketClass;
    this.ws = undefined;
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
      const headers = this.config.relayToken
        ? { authorization: `Bearer ${this.config.relayToken}` }
        : {};
      const ws = new this.WebSocketClass(this.config.relayUrl, { headers });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new RelayUnavailableError('Relay connection timed out'));
      }, this.config.connectTimeoutMs);

      const rejectOnce = (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new RelayUnavailableError(String(error)));
      };

      ws.once('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.#attachSocket(ws);
        this.#startHeartbeat();
        this.logger?.info('relay_connected', { relayUrl: this.config.relayUrl });
        resolve(ws);
      });
      ws.once('error', rejectOnce);
      ws.once('close', (code, reason) => {
        if (this.ws !== ws) rejectOnce(new RelayUnavailableError(`Relay closed: ${code} ${reason}`));
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
  }

  #attachSocket(ws) {
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          this.#handleBinary(data);
        } else {
          this.#handleJson(decodeJsonMessage(data));
        }
      } catch (error) {
        this.logger?.warn('relay_message_error', {
          code: error.code,
          message: error.message
        });
      }
    });

    ws.on('close', (code, reason) => {
      this.logger?.warn('relay_disconnected', { code, reason: reason.toString() });
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      if (this.ws === ws) this.ws = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new RelayUnavailableError('Relay connection closed'));
      }
      this.pending.clear();
    });

    ws.on('error', (error) => {
      this.logger?.warn('relay_socket_error', { message: error.message });
    });
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

    await new Promise((resolve, reject) => {
      ws.send(data, options, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
