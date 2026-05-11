import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { splitBuffer } from '../shared/chunking.js';
import {
  UPSTREAM_ROUTING_AUTO,
  UPSTREAM_PROVIDER_ANTHROPIC,
  UPSTREAM_PROVIDER_OPENAI
} from '../shared/config.js';
import {
  E2EE_HANDSHAKE_TIMEOUT_MS,
  E2EE_MODE_OFF,
  E2EE_MODE_REQUIRED,
  createServerE2eeSession,
  createServerHello
} from '../shared/e2ee.js';
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

    const mode = relayE2eeMode(config);
    const preauthorized = isAuthorized(request.headers.authorization, config.relayToken);
    if (mode === E2EE_MODE_OFF && !preauthorized) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (mode !== E2EE_MODE_OFF && request.headers.authorization && !preauthorized) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    request.relaySession = {
      preauthorized: mode !== E2EE_MODE_REQUIRED && preauthorized
    };

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
  const session = {
    authenticated: Boolean(request.relaySession?.preauthorized),
    e2ee: undefined,
    e2eeMode: relayE2eeMode(config),
    handshakeTimer: undefined
  };

  if (!session.authenticated && session.e2eeMode !== E2EE_MODE_OFF) {
    session.handshakeTimer = setTimeout(() => {
      ws.close(1008, 'E2EE authentication timeout');
    }, config.relayE2eeHandshakeTimeoutMs ?? E2EE_HANDSHAKE_TIMEOUT_MS);
    session.handshakeTimer.unref?.();
  }

  logger.info('relay_session_open', {
    remoteAddress: request.socket.remoteAddress,
    relayE2eeMode: session.e2eeMode,
    relayE2eeAuthenticated: session.authenticated
  });

  ws.on('message', (data, isBinary) => {
    Promise.resolve()
      .then(async () => {
        await handleSessionFrame(
          ws,
          session,
          reassembler,
          activeUpstream,
          config,
          logger,
          fetchImpl,
          data,
          isBinary
        );
      })
      .catch((error) => {
        logger.warn('relay_session_message_failed', {
          code: error.code,
          status: error.status,
          message: error.message
        });
        sendError(ws, {
          session,
          id: error.id,
          code: error.code ?? 'RELAY_ERROR',
          message: error.message,
          status: error.status ?? 400
        });
        if (!session.authenticated || String(error.code ?? '').startsWith('E2EE_')) {
          ws.close(1008, error.code ?? 'RELAY_ERROR');
        }
      });
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    clearTimeout(session.handshakeTimer);
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

async function handleSessionFrame(
  ws,
  session,
  reassembler,
  activeUpstream,
  config,
  logger,
  fetchImpl,
  data,
  isBinary
) {
  if (!session.e2ee && !session.authenticated) {
    await handleUnauthenticatedFrame(ws, session, config, logger, data, isBinary);
    return;
  }

  if (session.e2ee) {
    if (!isBinary) {
      await failSession(ws, session, {
        code: 'E2EE_PLAINTEXT_FRAME',
        message: 'Encrypted relay session received plaintext frame',
        status: 400
      });
      return;
    }
    const plaintext = session.e2ee.open(data);
    if (isJsonFrame(plaintext)) {
      await handleJsonMessage(
        ws,
        session,
        reassembler,
        activeUpstream,
        config,
        logger,
        fetchImpl,
        plaintext
      );
    } else {
      await handleBinaryMessage(ws, reassembler, plaintext);
    }
    return;
  }

  if (isBinary) {
    await handleBinaryMessage(ws, reassembler, data);
  } else {
    await handleJsonMessage(ws, session, reassembler, activeUpstream, config, logger, fetchImpl, data);
  }
}

async function handleUnauthenticatedFrame(ws, session, config, logger, data, isBinary) {
  if (session.e2eeMode === E2EE_MODE_OFF) {
    await failSession(ws, session, {
      code: 'UNAUTHORIZED',
      message: 'Relay session is not authorized',
      status: 401
    });
    return;
  }
  if (isBinary) {
    await failSession(ws, session, {
      code: 'E2EE_HANDSHAKE_REQUIRED',
      message: 'E2EE handshake is required before binary relay messages',
      status: 401
    });
    return;
  }

  const message = decodeJsonMessage(data);
  if (message.type !== MESSAGE_TYPES.E2EE_CLIENT_HELLO) {
    await failSession(ws, session, {
      code: 'E2EE_HANDSHAKE_REQUIRED',
      message: 'E2EE handshake is required before relay messages',
      status: 401
    });
    return;
  }

  const psk = config.relayE2eeKeys?.get(message.keyId);
  if (!psk) {
    await failSession(ws, session, {
      code: 'E2EE_UNKNOWN_KEY',
      message: 'Unknown E2EE key id',
      status: 401
    });
    return;
  }

  const { serverNonce, sessionId, suite, message: serverHello } = createServerHello({
    clientHello: message
  });
  session.e2ee = createServerE2eeSession({
    keyId: message.keyId,
    psk,
    clientNonce: message.clientNonce,
    serverNonce,
    sessionId,
    suite
  });
  session.e2eeKeyId = message.keyId;
  await sendPlainRaw(ws, encodeJsonMessage(serverHello));
  logger.info('relay_e2ee_handshake_started', { keyId: message.keyId });
}

async function handleJsonMessage(ws, session, reassembler, activeUpstream, config, logger, fetchImpl, data) {
  const message = decodeJsonMessage(data);

  if (message.type === MESSAGE_TYPES.E2EE_SESSION_AUTH) {
    await handleEncryptedAuth(ws, session, config, logger, message);
    return;
  }

  if (!session.authenticated) {
    await failSession(ws, session, {
      code: 'UNAUTHORIZED',
      message: 'Relay session is not authenticated',
      status: 401
    });
    return;
  }

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
    forwardUpstream(ws, session, activeUpstream, config, logger, fetchImpl, complete).catch((error) => {
      sendError(ws, {
        session,
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
    await sendJsonMessage(ws, session, { type: MESSAGE_TYPES.PONG });
  }
}

async function handleEncryptedAuth(ws, session, config, logger, message) {
  if (!session.e2ee) {
    await failSession(ws, session, {
      code: 'E2EE_HANDSHAKE_REQUIRED',
      message: 'E2EE authentication requires a completed handshake',
      status: 401
    });
    return;
  }

  if (!isAuthorized(message.relayToken ? `Bearer ${message.relayToken}` : '', config.relayToken)) {
    await failSession(ws, session, {
      code: 'UNAUTHORIZED',
      message: 'Invalid relay authentication',
      status: 401
    });
    return;
  }

  session.authenticated = true;
  clearTimeout(session.handshakeTimer);
  session.handshakeTimer = undefined;
  await sendJsonMessage(ws, session, { type: MESSAGE_TYPES.ACK });
  logger.info('relay_e2ee_session_authenticated', {
    keyId: session.e2eeKeyId,
    relayE2eeMode: session.e2eeMode
  });
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

async function forwardUpstream(ws, session, activeUpstream, config, logger, fetchImpl, { metadata, body }) {
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
    const upstreamRoute = selectUpstreamRoute(config, metadata);
    const mappedRequest = applyModelIdMap(body, config.modelIdMap);
    const response = await fetchImpl(upstreamRoute.url, {
      method: metadata.method,
      headers: buildProviderUpstreamHeaders(metadata.headers, upstreamRoute.upstream),
      body: allowsBody(metadata.method) ? mappedRequest.body : undefined,
      signal: controller.signal
    });

    const responseHeaders = filterResponseHeaders(response.headers);
    const stream = Boolean(metadata.stream) || isStreamingHeaders(responseHeaders);
    await sendJsonMessage(ws, session, {
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
            seq = await sendChunkedResponsePart(ws, session, metadata.id, seq, mappedPart, config.chunkSize);
          }
        }
        for (const mappedPart of mapper.flush()) {
          seq = await sendChunkedResponsePart(ws, session, metadata.id, seq, mappedPart, config.chunkSize);
        }
      } else if (stream) {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          responseBytes += buffer.length;
          assertResponseSize(responseBytes, config.maxResponseBytes);
          seq = await sendChunkedResponsePart(ws, session, metadata.id, seq, buffer, config.chunkSize);
        }
      } else {
        const upstreamBody = await readUpstreamBody(response.body, config.maxResponseBytes);
        const mappedResponse = applyResponseModelIdMap(upstreamBody, mappedRequest);
        responseBytes = mappedResponse.body.length;
        seq = await sendChunkedResponsePart(
          ws,
          session,
          metadata.id,
          seq,
          mappedResponse.body,
          config.chunkSize
        );
      }
    }

    await sendJsonMessage(ws, session, { type: MESSAGE_TYPES.RESPONSE_END, id: metadata.id });
    logger.info('relay_request_complete', {
      requestId: metadata.id,
      method: metadata.method,
      path: metadata.path,
      upstreamProvider: upstreamRoute.provider,
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
        session,
        id: metadata.id,
        code: 'CANCELLED',
        message: 'Request was cancelled',
        status: 499
      });
      return;
    }
    if (timedOut) {
      await sendError(ws, {
        session,
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

async function sendChunkedResponsePart(ws, session, id, seq, buffer, chunkSize) {
  for (const part of splitBuffer(buffer, chunkSize)) {
    await sendBinaryMessage(
      ws,
      session,
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

function selectUpstreamRoute(config, metadata) {
  const route = resolveUpstreamRoute(config, metadata.path);
  const upstream = getUpstreamConfig(config, route.provider);
  return {
    ...route,
    upstream,
    url: buildProviderUpstreamUrl(upstream, route.upstreamPath)
  };
}

function resolveUpstreamRoute(config, requestPath) {
  if ((config.upstreamRouting ?? 'single') !== UPSTREAM_ROUTING_AUTO) {
    return {
      provider: upstreamProvider(config),
      upstreamPath: requestPath
    };
  }

  const url = new URL(requestPath, 'http://relay.local');
  if (url.pathname === '/v1/chat/completions') {
    return { provider: UPSTREAM_PROVIDER_OPENAI, upstreamPath: `${url.pathname}${url.search}` };
  }
  if (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens') {
    return { provider: UPSTREAM_PROVIDER_ANTHROPIC, upstreamPath: `${url.pathname}${url.search}` };
  }
  if (url.pathname === '/v1/models') {
    const requestedProvider = url.searchParams.get('provider');
    const provider = requestedProvider ? parseRouteProvider(requestedProvider) : upstreamProvider(config);
    url.searchParams.delete('provider');
    return {
      provider,
      upstreamPath: `${url.pathname}${url.search}`
    };
  }

  return {
    provider: upstreamProvider(config),
    upstreamPath: requestPath
  };
}

function parseRouteProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (provider === UPSTREAM_PROVIDER_OPENAI || provider === UPSTREAM_PROVIDER_ANTHROPIC) {
    return provider;
  }
  throw Object.assign(new Error('Unsupported upstream provider route'), {
    code: 'INVALID_UPSTREAM_PROVIDER',
    status: 400
  });
}

function getUpstreamConfig(config, provider) {
  const configured = config.upstreamProviders?.[provider];
  if (configured) return configured;

  return {
    provider,
    baseUrl: config.upstreamBaseUrl,
    apiKey: config.upstreamApiKey,
    authScheme: config.upstreamAuthScheme ?? 'Bearer',
    anthropicVersion: config.anthropicVersion,
    anthropicBeta: config.anthropicBeta
  };
}

function buildProviderUpstreamUrl(upstream, requestPath) {
  const base = new URL(upstream.baseUrl);
  const request = new URL(requestPath, 'http://relay.local');
  const basePath = base.pathname.replace(/\/+$/, '');
  const requestPathname = request.pathname.replace(/^\/+/, '');
  base.pathname = `${basePath}/${requestPathname}`.replace(/\/{2,}/g, '/');
  base.search = request.search;
  base.hash = '';
  return base.toString();
}

function buildProviderUpstreamHeaders(headers, upstream) {
  const forwarded = {};
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const key = rawKey.toLowerCase();
    if (key === 'authorization' || key === 'x-api-key' || key === 'content-length' || key === 'host') continue;
    forwarded[key] = String(rawValue);
  }

  if (upstream.provider === UPSTREAM_PROVIDER_ANTHROPIC) {
    if (upstream.apiKey) forwarded['x-api-key'] = upstream.apiKey;
    if (upstream.anthropicVersion) forwarded['anthropic-version'] = upstream.anthropicVersion;
    if (upstream.anthropicBeta) forwarded['anthropic-beta'] = upstream.anthropicBeta;
    return forwarded;
  }

  if (upstream.apiKey) {
    forwarded.authorization = `${upstream.authScheme ?? 'Bearer'} ${upstream.apiKey}`;
  }
  return forwarded;
}

function upstreamProvider(config) {
  return config.upstreamProvider ?? UPSTREAM_PROVIDER_OPENAI;
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

function relayE2eeMode(config) {
  return config.relayE2eeMode ?? E2EE_MODE_OFF;
}

function isJsonFrame(data) {
  const buffer = Buffer.from(data);
  return buffer.length > 0 && buffer[0] === 0x7b;
}

async function failSession(ws, session, { code, message, status }) {
  await sendError(ws, { session, code, message, status });
  ws.close(1008, code);
}

async function sendJsonMessage(ws, session, message) {
  return sendRaw(ws, session, encodeJsonMessage(message));
}

async function sendBinaryMessage(ws, session, frame) {
  return sendRaw(ws, session, frame, { binary: true });
}

async function sendError(ws, { session, id, code, message, status }) {
  try {
    await sendJsonMessage(ws, session, errorMessage({ id, code, message, status }));
  } catch {
    // The socket may already be gone; request cleanup is handled by callers.
  }
}

async function sendRaw(ws, session, data, options = {}) {
  if (session?.e2ee) {
    return sendPlainRaw(ws, session.e2ee.seal(data), { binary: true });
  }
  return sendPlainRaw(ws, data, options);
}

async function sendPlainRaw(ws, data, options = {}) {
  if (ws.readyState !== 1) return;
  await new Promise((resolve, reject) => {
    ws.send(data, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
