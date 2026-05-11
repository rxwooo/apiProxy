import { createServer } from 'node:http';
import { filterResponseHeaders, parseJsonBody, readRequestBody, selectForwardHeaders, sendJson } from '../shared/http.js';
import { RelayResponseError, RelayTimeoutError, RelayUnavailableError } from './relayClient.js';

const CORS_ALLOW_HEADERS = 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta';

export function createLocalProxyServer(config, { relayClient, logger }) {
  return createServer(async (request, response) => {
    const startedAt = Date.now();
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': CORS_ALLOW_HEADERS
        });
        response.end();
        return;
      }

      if (isRelayableRequest(request.method, url.pathname)) {
        await relayHttpRequest({ request, response, url, config, relayClient, logger, startedAt });
        return;
      }

      sendJson(response, 404, { error: { message: 'Not found', code: 'NOT_FOUND' } });
    } catch (error) {
      writeGatewayError(response, error, logger);
    }
  });
}

async function relayHttpRequest({ request, response, url, config, relayClient, logger, startedAt }) {
  const body =
    request.method === 'GET'
      ? Buffer.alloc(0)
      : await readRequestBody(request, { maxBytes: config.maxRequestBytes });

  const stream = isStreamRequest(url.pathname, body);
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.on('aborted', abort);
  response.on('close', abort);

  let responseStarted = false;
  let responseBytes = 0;

  try {
    await relayClient.relayRequest({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: selectForwardHeaders(request.headers),
      body,
      stream,
      signal: controller.signal,
      onResponseStart: ({ status, headers }) => {
        responseStarted = true;
        response.writeHead(status, {
          ...filterResponseHeaders(headers),
          'access-control-allow-origin': '*'
        });
      },
      onResponseChunk: (chunk) => {
        responseBytes += chunk.length;
        if (!responseStarted) {
          responseStarted = true;
          response.writeHead(200, { 'access-control-allow-origin': '*' });
        }
        response.write(chunk);
      }
    });

    if (!response.writableEnded) response.end();
    logger?.info('local_request_complete', {
      method: request.method,
      path: url.pathname,
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
      requestBytes: body.length,
      responseBytes
    });
  } catch (error) {
    if (controller.signal.aborted && response.writableEnded) return;
    writeGatewayError(response, error, logger);
  } finally {
    request.off('aborted', abort);
    response.off('close', abort);
  }
}

function isRelayableRequest(method, pathname) {
  return (
    (method === 'POST' &&
      ['/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) ||
    (method === 'GET' && pathname === '/v1/models')
  );
}

function isStreamRequest(pathname, body) {
  if (!['/v1/chat/completions', '/v1/messages'].includes(pathname) || !body.length) return false;
  try {
    const parsed = parseJsonBody(body);
    return Boolean(parsed?.stream);
  } catch {
    return false;
  }
}

function writeGatewayError(response, error, logger) {
  logger?.warn('local_request_failed', {
    code: error.code,
    status: error.status,
    message: error.message,
    relayProxyConfigured: error.relayProxyConfigured,
    relayProxyEnabled: error.relayProxyEnabled,
    relayProxyBypassed: error.relayProxyBypassed,
    relayProxyHost: error.relayProxyHost
  });

  if (response.headersSent) {
    response.destroy(error);
    return;
  }

  let status = error.status ?? 502;
  if (error instanceof RelayTimeoutError) status = 504;
  if (error instanceof RelayUnavailableError) status = 502;
  if (error instanceof RelayResponseError && error.status) status = error.status;

  sendJson(response, status, {
    error: {
      message: error.message,
      code: error.code ?? 'RELAY_ERROR'
    }
  });
}
