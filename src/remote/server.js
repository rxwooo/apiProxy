import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { splitBuffer } from '../shared/chunking.js';
import { filterResponseHeaders, isStreamingHeaders, sendJson } from '../shared/http.js';
import { createLogger } from '../shared/logger.js';
import {
  MESSAGE_TYPES,
  decodeChunkMessage,
  decodeJsonMessage,
  encodeChunkMessage,
  encodeJsonMessage,
  errorMessage
} from '../shared/protocol.js';
import { RequestReassembler } from '../shared/reassembly.js';
import {
  applyModelIdMap,
  applyResponseModelIdMap,
  createSseResponseModelMapper
} from './modelMapping.js';

export function createRemoteRelayServer(config, { logger = createLogger({ name: 'remote-relay' }), fetchImpl = fetch } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: { message: 'Not found', code: 'NOT_FOUND' } });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== config.relayPath) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!isAuthorized(request.headers.authorization, config.relayToken)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    handleSession(ws, request, config, logger, fetchImpl);
  });

  server.wss = wss;
  return server;
}

function handleSession(ws, request, config, logger, fetchImpl) {
  const reassembler = new RequestReassembler({
    maxBytes: config.maxRequestBytes,
    maxConcurrent: config.maxConcurrentRequests,
    timeoutMs: config.requestTimeoutMs
  });
  const activeUpstream = new Map();
  const heartbeat = attachHeartbeat(ws, config.heartbeatIntervalMs);

  logger.info('relay_session_open', {
    remoteAddress: request.socket.remoteAddress
  });

  ws.on('message', (data, isBinary) => {
    Promise.resolve()
      .then(async () => {
        if (isBinary) {
          await handleBinaryMessage(ws, reassembler, data);
        } else {
          await handleJsonMessage(ws, reassembler, activeUpstream, config, logger, fetchImpl, data);
        }
      })
      .catch((error) => {
        logger.warn('relay_session_message_failed', {
          code: error.code,
          status: error.status,
          message: error.message
        });
        sendError(ws, {
          id: error.id,
          code: error.code ?? 'RELAY_ERROR',
          message: error.message,
          status: error.status ?? 400
        });
      });
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    reassembler.abortAll();
    for (const entry of activeUpstream.values()) {
      entry.cancelled = true;
      entry.controller.abort();
    }
    activeUpstream.clear();
    logger.info('relay_session_closed', { code, reason: reason.toString() });
  });

  ws.on('error', (error) => {
    logger.warn('relay_session_socket_error', { message: error.message });
  });
}

async function handleJsonMessage(ws, reassembler, activeUpstream, config, logger, fetchImpl, data) {
  const message = decodeJsonMessage(data);

  if (message.type === MESSAGE_TYPES.REQUEST_START) {
    try {
      reassembler.start(normalizeRequestMetadata(message));
    } catch (error) {
      error.id = message.id;
      throw error;
    }
    logger.info('relay_request_started', {
      requestId: message.id,
      method: message.method,
      path: message.path,
      totalBytes: message.totalBytes
    });
    return;
  }

  if (message.type === MESSAGE_TYPES.REQUEST_END) {
    let complete;
    try {
      complete = reassembler.finish({
        id: message.id,
        chunks: message.chunks,
        sha256: message.sha256
      });
    } catch (error) {
      error.id = message.id;
      throw error;
    }
    forwardUpstream(ws, activeUpstream, config, logger, fetchImpl, complete).catch((error) => {
      sendError(ws, {
        id: message.id,
        code: error.code ?? 'UPSTREAM_ERROR',
        message: error.message,
        status: error.status ?? 502
      });
    });
    return;
  }

  if (message.type === MESSAGE_TYPES.REQUEST_CANCEL) {
    reassembler.abort(message.id);
    const active = activeUpstream.get(message.id);
    if (active) {
      active.cancelled = true;
      active.controller.abort();
      activeUpstream.delete(message.id);
      logger.info('relay_request_cancelled', {
        requestId: message.id,
        reason: message.reason
      });
    }
    return;
  }

  if (message.type === MESSAGE_TYPES.PING) {
    await sendJsonMessage(ws, { type: MESSAGE_TYPES.PONG });
  }
}

async function handleBinaryMessage(ws, reassembler, data) {
  const { header, payload } = decodeChunkMessage(data);
  if (header.type !== MESSAGE_TYPES.REQUEST_CHUNK) return;
  try {
    reassembler.addChunk({ id: header.id, seq: header.seq, payload });
  } catch (error) {
    error.id = header.id;
    throw error;
  }
}

async function forwardUpstream(ws, activeUpstream, config, logger, fetchImpl, { metadata, body }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const active = { controller, cancelled: false };
  activeUpstream.set(metadata.id, active);
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.requestTimeoutMs);

  try {
    const upstreamUrl = buildUpstreamUrl(config.upstreamBaseUrl, metadata.path);
    const mappedRequest = applyModelIdMap(body, config.modelIdMap);
    const response = await fetchImpl(upstreamUrl, {
      method: metadata.method,
      headers: buildUpstreamHeaders(metadata.headers, config),
      body: allowsBody(metadata.method) ? mappedRequest.body : undefined,
      signal: controller.signal
    });

    const responseHeaders = filterResponseHeaders(response.headers);
    const stream = Boolean(metadata.stream) || isStreamingHeaders(responseHeaders);
    await sendJsonMessage(ws, {
      type: MESSAGE_TYPES.RESPONSE_START,
      id: metadata.id,
      status: response.status,
      headers: responseHeaders,
      stream
    });

    let seq = 0;
    let responseBytes = 0;
    if (response.body) {
      const responseContentType = String(responseHeaders['content-type'] ?? '').toLowerCase();
      if (responseContentType.includes('text/event-stream')) {
        const mapper = createSseResponseModelMapper(mappedRequest);
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          responseBytes += buffer.length;
          assertResponseSize(responseBytes, config.maxResponseBytes);
          for (const mappedPart of mapper.push(buffer)) {
            seq = await sendChunkedResponsePart(ws, metadata.id, seq, mappedPart, config.chunkSize);
          }
        }
        for (const mappedPart of mapper.flush()) {
          seq = await sendChunkedResponsePart(ws, metadata.id, seq, mappedPart, config.chunkSize);
        }
      } else if (stream) {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          responseBytes += buffer.length;
          assertResponseSize(responseBytes, config.maxResponseBytes);
          seq = await sendChunkedResponsePart(ws, metadata.id, seq, buffer, config.chunkSize);
        }
      } else {
        const upstreamBody = await readUpstreamBody(response.body, config.maxResponseBytes);
        const mappedResponse = applyResponseModelIdMap(upstreamBody, mappedRequest);
        responseBytes = mappedResponse.body.length;
        seq = await sendChunkedResponsePart(
          ws,
          metadata.id,
          seq,
          mappedResponse.body,
          config.chunkSize
        );
      }
    }

    await sendJsonMessage(ws, { type: MESSAGE_TYPES.RESPONSE_END, id: metadata.id });
    logger.info('relay_request_complete', {
      requestId: metadata.id,
      method: metadata.method,
      path: metadata.path,
      upstreamStatus: response.status,
      durationMs: Date.now() - startedAt,
      requestBytes: body.length,
      upstreamRequestBytes: mappedRequest.body.length,
      modelMapped: mappedRequest.mapped,
      modelAlias: mappedRequest.originalModel,
      responseBytes
    });
  } catch (error) {
    if (active.cancelled) {
      await sendError(ws, {
        id: metadata.id,
        code: 'CANCELLED',
        message: 'Request was cancelled',
        status: 499
      });
      return;
    }
    if (timedOut) {
      await sendError(ws, {
        id: metadata.id,
        code: 'UPSTREAM_TIMEOUT',
        message: 'Upstream request timed out',
        status: 504
      });
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    activeUpstream.delete(metadata.id);
  }
}

async function readUpstreamBody(body, maxResponseBytes) {
  const chunks = [];
  let responseBytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    responseBytes += buffer.length;
    assertResponseSize(responseBytes, maxResponseBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, responseBytes);
}

async function sendChunkedResponsePart(ws, id, seq, buffer, chunkSize) {
  for (const part of splitBuffer(buffer, chunkSize)) {
    await sendBinaryMessage(
      ws,
      encodeChunkMessage({ type: MESSAGE_TYPES.RESPONSE_CHUNK, id, seq }, part)
    );
    seq += 1;
  }
  return seq;
}

function assertResponseSize(responseBytes, maxResponseBytes) {
  if (responseBytes > maxResponseBytes) {
    throw Object.assign(new Error('Upstream response exceeds configured maximum size'), {
      code: 'RESPONSE_TOO_LARGE',
      status: 502
    });
  }
}

function normalizeRequestMetadata(message) {
  if (!message.id || !message.method || !message.path) {
    const error = new Error('Request metadata is missing required fields');
    error.code = 'INVALID_REQUEST_METADATA';
    error.status = 400;
    throw error;
  }
  return {
    id: message.id,
    method: String(message.method).toUpperCase(),
    path: message.path,
    headers: message.headers ?? {},
    stream: Boolean(message.stream),
    encoding: message.encoding ?? 'identity',
    totalBytes: Number(message.totalBytes ?? 0)
  };
}

function buildUpstreamUrl(baseUrl, requestPath) {
  return new URL(requestPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function buildUpstreamHeaders(headers, config) {
  const forwarded = {};
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const key = rawKey.toLowerCase();
    if (key === 'authorization' || key === 'content-length' || key === 'host') continue;
    forwarded[key] = String(rawValue);
  }
  if (config.upstreamApiKey) {
    forwarded.authorization = `${config.upstreamAuthScheme} ${config.upstreamApiKey}`;
  }
  return forwarded;
}

function allowsBody(method) {
  return !['GET', 'HEAD'].includes(String(method).toUpperCase());
}

function isAuthorized(header, expectedToken) {
  if (!expectedToken) return true;
  return header === `Bearer ${expectedToken}`;
}

function rejectUpgrade(socket, status, message) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: ${message.length}\r\n\r\n${message}`
  );
  socket.destroy();
}

function attachHeartbeat(ws, intervalMs) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const timer = setInterval(() => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, intervalMs);
  timer.unref?.();
  return timer;
}

async function sendJsonMessage(ws, message) {
  return sendRaw(ws, encodeJsonMessage(message));
}

async function sendBinaryMessage(ws, frame) {
  return sendRaw(ws, frame, { binary: true });
}

async function sendError(ws, { id, code, message, status }) {
  try {
    await sendJsonMessage(ws, errorMessage({ id, code, message, status }));
  } catch {
    // The socket may already be gone; request cleanup is handled by callers.
  }
}

async function sendRaw(ws, data, options = {}) {
  if (ws.readyState !== 1) return;
  await new Promise((resolve, reject) => {
    ws.send(data, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
