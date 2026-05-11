import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import WebSocket from 'ws';
import { splitBuffer, sha256Hex } from '../../src/shared/chunking.js';
import { createLogger } from '../../src/shared/logger.js';
import {
  MESSAGE_TYPES,
  decodeJsonMessage,
  encodeChunkMessage,
  encodeJsonMessage
} from '../../src/shared/protocol.js';
import { E2EE_MODE_REQUIRED as REQUIRED_E2EE_MODE } from '../../src/shared/e2ee.js';
import { RelayClient } from '../../src/local/relayClient.js';
import { createLocalProxyServer } from '../../src/local/server.js';
import { createRemoteRelayServer } from '../../src/remote/server.js';

const logger = createLogger({ level: 'silent' });
const E2EE_KEY = Buffer.alloc(32, 7);
const E2EE_OTHER_KEY = Buffer.alloc(32, 8);

function commonConfig(overrides = {}) {
  return {
    chunkSize: 4096,
    requestTimeoutMs: 1000,
    connectTimeoutMs: 500,
    heartbeatIntervalMs: 5000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    maxConcurrentRequests: 8,
    logLevel: 'silent',
    nodeEnv: 'test',
    ...overrides
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startStack(upstreamHandler, overrides = {}) {
  const upstream = createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const e2eeEnabled = Boolean(overrides.e2ee);
  const e2eeKeyId = overrides.relayE2eeKeyId ?? 'main';
  const upstreamProviders = overrides.upstreamProviders ?? {
    openai: {
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: overrides.openaiApiKey ?? overrides.upstreamApiKey ?? 'upstream-token',
      authScheme: overrides.openaiAuthScheme ?? overrides.upstreamAuthScheme ?? 'Bearer'
    },
    anthropic: {
      provider: 'anthropic',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: overrides.anthropicApiKey ?? overrides.upstreamApiKey ?? 'upstream-token',
      anthropicVersion: overrides.anthropicVersion,
      anthropicBeta: overrides.anthropicBeta
    }
  };

  const remoteConfig = commonConfig({
    host: '127.0.0.1',
    port: 0,
    relayPath: '/relay',
    relayToken: overrides.remoteToken ?? 'relay-token',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamRouting: overrides.upstreamRouting ?? 'single',
    upstreamProvider: overrides.upstreamProvider,
    upstreamProviders,
    upstreamApiKey: overrides.upstreamApiKey ?? 'upstream-token',
    upstreamAuthScheme: overrides.upstreamAuthScheme ?? 'Bearer',
    anthropicVersion: overrides.anthropicVersion,
    anthropicBeta: overrides.anthropicBeta,
    modelIdMap: overrides.modelIdMap ?? {},
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1000,
    relayE2eeMode: overrides.remoteE2eeMode ?? (e2eeEnabled ? REQUIRED_E2EE_MODE : 'off'),
    relayE2eeKeys:
      overrides.remoteE2eeKeys ?? (e2eeEnabled ? new Map([[e2eeKeyId, E2EE_KEY]]) : new Map()),
    relayE2eeHandshakeTimeoutMs: overrides.relayE2eeHandshakeTimeoutMs ?? 250
  });
  const remote = createRemoteRelayServer(remoteConfig, { logger });
  const remotePort = await listen(remote);

  const localConfig = commonConfig({
    host: '127.0.0.1',
    port: 0,
    relayUrl: `ws://127.0.0.1:${remotePort}/relay`,
    relayToken: overrides.localToken ?? 'relay-token',
    relayProxy: overrides.relayProxy ?? '',
    relayNoProxy: overrides.relayNoProxy ?? [],
    requestTimeoutMs: overrides.localRequestTimeoutMs ?? overrides.requestTimeoutMs ?? 1000,
    relayE2eeMode: overrides.localE2eeMode ?? (e2eeEnabled ? REQUIRED_E2EE_MODE : 'off'),
    relayE2eeKeyId: e2eeKeyId,
    relayE2eePsk: overrides.localE2eePsk ?? (e2eeEnabled ? E2EE_KEY : undefined)
  });
  const relayClient = new RelayClient(localConfig, {
    logger,
    ...(overrides.WebSocketClass ? { WebSocketClass: overrides.WebSocketClass } : {})
  });
  const local = createLocalProxyServer(localConfig, { relayClient, logger });
  const localPort = await listen(local);

  return {
    upstream,
    remote,
    local,
    relayClient,
    localUrl: `http://127.0.0.1:${localPort}`,
    remoteUrl: `ws://127.0.0.1:${remotePort}/relay`,
    async close() {
      await relayClient.close();
      remote.wss?.clients.forEach((client) => client.terminate());
      await closeServer(local);
      await closeServer(remote);
      await closeServer(upstream);
    }
  };
}

async function startAutoRoutingStack({
  openaiHandler,
  anthropicHandler,
  defaultProvider = 'openai',
  anthropicBasePath = ''
} = {}) {
  const openaiUpstream = createServer(openaiHandler);
  const openaiPort = await listen(openaiUpstream);
  const anthropicUpstream = createServer(anthropicHandler);
  const anthropicPort = await listen(anthropicUpstream);

  const remoteConfig = commonConfig({
    host: '127.0.0.1',
    port: 0,
    relayPath: '/relay',
    relayToken: 'relay-token',
    upstreamRouting: 'auto',
    upstreamProvider: defaultProvider,
    upstreamProviders: {
      openai: {
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${openaiPort}`,
        apiKey: 'openai-token',
        authScheme: 'Bearer'
      },
      anthropic: {
        provider: 'anthropic',
        baseUrl: `http://127.0.0.1:${anthropicPort}${anthropicBasePath}`,
        apiKey: 'anthropic-token',
        anthropicVersion: '2023-06-01',
        anthropicBeta: 'test-beta'
      }
    },
    upstreamBaseUrl: `http://127.0.0.1:${openaiPort}`,
    upstreamApiKey: 'openai-token'
  });
  const remote = createRemoteRelayServer(remoteConfig, { logger });
  const remotePort = await listen(remote);

  const localConfig = commonConfig({
    host: '127.0.0.1',
    port: 0,
    relayUrl: `ws://127.0.0.1:${remotePort}/relay`,
    relayToken: 'relay-token',
    relayProxy: '',
    relayNoProxy: [],
    relayE2eeMode: 'off'
  });
  const relayClient = new RelayClient(localConfig, { logger });
  const local = createLocalProxyServer(localConfig, { relayClient, logger });
  const localPort = await listen(local);

  return {
    remote,
    local,
    relayClient,
    openaiUpstream,
    anthropicUpstream,
    localUrl: `http://127.0.0.1:${localPort}`,
    async close() {
      await relayClient.close();
      remote.wss?.clients.forEach((client) => client.terminate());
      await closeServer(local);
      await closeServer(remote);
      await closeServer(openaiUpstream);
      await closeServer(anthropicUpstream);
    }
  };
}

async function startConnectProxy() {
  const sockets = new Set();
  let connectCount = 0;
  const proxy = createServer();

  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  proxy.on('connect', (request, clientSocket, head) => {
    connectCount += 1;
    const [host, port = '80'] = request.url.split(':');
    const upstreamSocket = connectSocket(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    sockets.add(upstreamSocket);
    upstreamSocket.on('close', () => sockets.delete(upstreamSocket));
    upstreamSocket.on('error', () => {
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });
  });

  const port = await listen(proxy);
  return {
    url: `http://127.0.0.1:${port}`,
    get connectCount() {
      return connectCount;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(proxy);
    }
  };
}

test('relays a chat completion request larger than 10 KB and returns non-streaming JSON', async () => {
  let upstreamBody;
  let upstreamAuth;
  const stack = await startStack(async (request, response) => {
    upstreamBody = await readRequestBody(request);
    upstreamAuth = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion' }));
  });

  try {
    const body = JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'x'.repeat(12_000) }]
    });
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: 'chatcmpl_test',
      object: 'chat.completion'
    });
    assert.ok(upstreamBody.length > 10_000);
    assert.equal(upstreamBody.toString(), body);
    assert.equal(upstreamAuth, 'Bearer upstream-token');
  } finally {
    await stack.close();
  }
});

test('preserves direct relay connection behavior when proxy is not configured', async () => {
  let upstreamBody;
  const stack = await startStack(async (request, response) => {
    upstreamBody = await readRequestBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(JSON.parse(upstreamBody.toString()).model, 'test-model');
  } finally {
    await stack.close();
  }
});

test('connects to the remote relay through an explicit HTTP CONNECT proxy', async () => {
  const connectProxy = await startConnectProxy();
  let upstreamAuth;
  const stack = await startStack(
    async (request, response) => {
      await readRequestBody(request);
      upstreamAuth = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ proxied: true }));
    },
    { relayProxy: connectProxy.url }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { proxied: true });
    assert.equal(upstreamAuth, 'Bearer upstream-token');
    assert.equal(connectProxy.connectCount, 1);
  } finally {
    await stack.close();
    await connectProxy.close();
  }
});

test('returns gateway error for proxied relay authentication failure', async () => {
  const connectProxy = await startConnectProxy();
  const stack = await startStack(
    (_request, response) => {
      response.writeHead(500);
      response.end('should not be called');
    },
    { relayProxy: connectProxy.url, localToken: 'wrong-token' }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });

    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'RELAY_UNAVAILABLE');
    assert.equal(connectProxy.connectCount, 1);
  } finally {
    await stack.close();
    await connectProxy.close();
  }
});

test('maps client model alias to configured upstream model id on the remote relay', async () => {
  let upstreamPayload;
  const stack = await startStack(
    async (request, response) => {
      upstreamPayload = JSON.parse((await readRequestBody(request)).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          model: 'provider-real-model-id'
        })
      );
    },
    { modelIdMap: { A: 'provider-real-model-id' } }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'A',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });

    assert.equal(response.status, 200);
    const responseBody = await response.json();
    assert.equal(responseBody.model, 'A');
    assert.equal(upstreamPayload.model, 'provider-real-model-id');
    assert.deepEqual(upstreamPayload.messages, [{ role: 'user', content: 'hello' }]);
  } finally {
    await stack.close();
  }
});

test('maps upstream streaming response model id back to client model alias', async () => {
  const stack = await startStack(
    async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        'data: {"id":"chunk_1","model":"provider-real-model-id","choices":[{"delta":{"content":"hi"}}]}\n\n'
      );
      response.end('data: [DONE]\n\n');
    },
    { modelIdMap: { A: 'provider-real-model-id' } }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'A',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }]
      })
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"model":"A"/);
    assert.doesNotMatch(body, /provider-real-model-id/);
  } finally {
    await stack.close();
  }
});

test('relays GET /v1/models through the upstream path', async () => {
  let upstreamPath;
  const stack = await startStack(async (request, response) => {
    upstreamPath = request.url;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }));
  });

  try {
    const response = await fetch(`${stack.localUrl}/v1/models`);
    assert.equal(response.status, 200);
    assert.equal(upstreamPath, '/v1/models');
    assert.deepEqual(await response.json(), {
      object: 'list',
      data: [{ id: 'test-model' }]
    });
  } finally {
    await stack.close();
  }
});

test('relays native Anthropic messages and applies remote Anthropic headers', async () => {
  let upstreamPath;
  let upstreamBody;
  let upstreamHeaders;
  const stack = await startStack(
    async (request, response) => {
      upstreamPath = request.url;
      upstreamHeaders = request.headers;
      upstreamBody = await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hello' }]
        })
      );
    },
    {
      upstreamProvider: 'anthropic',
      anthropicVersion: '2023-06-01',
      anthropicBeta: 'test-beta'
    }
  );

  try {
    const body = JSON.stringify({
      model: 'claude-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }]
    });
    const response = await fetch(`${stack.localUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer client-token',
        'x-api-key': 'client-anthropic-key',
        'anthropic-version': 'client-version'
      },
      body
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamPath, '/v1/messages');
    assert.equal(upstreamBody.toString(), body);
    assert.equal(upstreamHeaders['x-api-key'], 'upstream-token');
    assert.equal(upstreamHeaders['anthropic-version'], '2023-06-01');
    assert.equal(upstreamHeaders['anthropic-beta'], 'test-beta');
    assert.equal(upstreamHeaders.authorization, undefined);
    assert.deepEqual(await response.json(), {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'hello' }]
    });
  } finally {
    await stack.close();
  }
});

test('relays native Anthropic token counting requests', async () => {
  let upstreamPath;
  let upstreamBody;
  const stack = await startStack(
    async (request, response) => {
      upstreamPath = request.url;
      upstreamBody = await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 7 }));
    },
    { upstreamProvider: 'anthropic', anthropicVersion: '2023-06-01' }
  );

  try {
    const body = JSON.stringify({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'count me' }]
    });
    const response = await fetch(`${stack.localUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamPath, '/v1/messages/count_tokens');
    assert.equal(upstreamBody.toString(), body);
    assert.deepEqual(await response.json(), { input_tokens: 7 });
  } finally {
    await stack.close();
  }
});

test('relays native Anthropic model list responses without schema conversion', async () => {
  let upstreamPath;
  const upstreamResponse = {
    data: [{ id: 'claude-test', type: 'model', display_name: 'Claude Test' }],
    has_more: false,
    first_id: 'claude-test',
    last_id: 'claude-test'
  };
  const stack = await startStack(
    async (request, response) => {
      upstreamPath = request.url;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(upstreamResponse));
    },
    { upstreamProvider: 'anthropic', anthropicVersion: '2023-06-01' }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/models`);
    assert.equal(response.status, 200);
    assert.equal(upstreamPath, '/v1/models');
    assert.deepEqual(await response.json(), upstreamResponse);
  } finally {
    await stack.close();
  }
});

test('relays native Anthropic SSE streams without OpenAI event conversion', async () => {
  let upstreamPayload;
  const stack = await startStack(
    async (request, response) => {
      upstreamPayload = JSON.parse((await readRequestBody(request)).toString('utf8'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        'event: message_start\n' +
          'data: {"type":"message_start","message":{"id":"msg_test","type":"message","model":"claude-test","content":[]}}\n\n'
      );
      response.write(
        'event: content_block_delta\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
      );
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    },
    { upstreamProvider: 'anthropic', anthropicVersion: '2023-06-01' }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'stream' }]
      })
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(upstreamPayload.stream, true);
    assert.match(body, /event: message_start/);
    assert.match(body, /content_block_delta/);
    assert.match(body, /text_delta/);
    assert.doesNotMatch(body, /"choices"/);
  } finally {
    await stack.close();
  }
});

test('auto routing sends OpenAI and Anthropic paths to separate upstream providers', async () => {
  const hits = [];
  const stack = await startAutoRoutingStack({
    openaiHandler: async (request, response) => {
      hits.push({
        provider: 'openai',
        path: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key']
      });
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ provider: 'openai' }));
    },
    anthropicHandler: async (request, response) => {
      hits.push({
        provider: 'anthropic',
        path: request.url,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'],
        version: request.headers['anthropic-version'],
        beta: request.headers['anthropic-beta']
      });
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ provider: 'anthropic' }));
    }
  });

  try {
    const openaiResponse = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', messages: [] })
    });
    const anthropicResponse = await fetch(`${stack.localUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 64, messages: [] })
    });
    const tokenCountResponse = await fetch(`${stack.localUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [] })
    });

    assert.deepEqual(await openaiResponse.json(), { provider: 'openai' });
    assert.deepEqual(await anthropicResponse.json(), { provider: 'anthropic' });
    assert.deepEqual(await tokenCountResponse.json(), { provider: 'anthropic' });
    assert.deepEqual(
      hits.map((hit) => hit.provider),
      ['openai', 'anthropic', 'anthropic']
    );
    assert.equal(hits[0].path, '/v1/chat/completions');
    assert.equal(hits[0].authorization, 'Bearer openai-token');
    assert.equal(hits[0].apiKey, undefined);
    assert.equal(hits[1].path, '/v1/messages');
    assert.equal(hits[1].authorization, undefined);
    assert.equal(hits[1].apiKey, 'anthropic-token');
    assert.equal(hits[1].version, '2023-06-01');
    assert.equal(hits[1].beta, 'test-beta');
    assert.equal(hits[2].path, '/v1/messages/count_tokens');
  } finally {
    await stack.close();
  }
});

test('auto routing preserves upstream base URL path prefixes', async () => {
  let anthropicPath;
  const stack = await startAutoRoutingStack({
    anthropicBasePath: '/anthropic',
    openaiHandler: async (_request, response) => {
      response.writeHead(500);
      response.end('should not be called');
    },
    anthropicHandler: async (request, response) => {
      anthropicPath = request.url;
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    }
  });

  try {
    const response = await fetch(`${stack.localUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 64, messages: [] })
    });

    assert.equal(response.status, 200);
    assert.equal(anthropicPath, '/anthropic/v1/messages');
  } finally {
    await stack.close();
  }
});

test('auto routing selects model provider by query and strips routing parameter', async () => {
  const hits = [];
  const stack = await startAutoRoutingStack({
    openaiHandler: async (request, response) => {
      hits.push({ provider: 'openai', path: request.url });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ provider: 'openai-models' }));
    },
    anthropicHandler: async (request, response) => {
      hits.push({ provider: 'anthropic', path: request.url });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ provider: 'anthropic-models' }));
    }
  });

  try {
    const anthropicResponse = await fetch(`${stack.localUrl}/v1/models?provider=anthropic&limit=2`);
    const openaiResponse = await fetch(`${stack.localUrl}/v1/models?provider=openai`);

    assert.deepEqual(await anthropicResponse.json(), { provider: 'anthropic-models' });
    assert.deepEqual(await openaiResponse.json(), { provider: 'openai-models' });
    assert.deepEqual(hits, [
      { provider: 'anthropic', path: '/v1/models?limit=2' },
      { provider: 'openai', path: '/v1/models' }
    ]);
  } finally {
    await stack.close();
  }
});

test('auto routing uses default provider for model list without query', async () => {
  const hits = [];
  const stack = await startAutoRoutingStack({
    defaultProvider: 'anthropic',
    openaiHandler: async (_request, response) => {
      hits.push('openai');
      response.writeHead(500);
      response.end('should not be called');
    },
    anthropicHandler: async (request, response) => {
      hits.push(`anthropic:${request.url}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ provider: 'anthropic-default' }));
    }
  });

  try {
    const response = await fetch(`${stack.localUrl}/v1/models`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider: 'anthropic-default' });
    assert.deepEqual(hits, ['anthropic:/v1/models']);
  } finally {
    await stack.close();
  }
});

test('auto routing rejects unsupported model provider query', async () => {
  let upstreamCalled = false;
  const stack = await startAutoRoutingStack({
    openaiHandler: async (_request, response) => {
      upstreamCalled = true;
      response.writeHead(500);
      response.end('should not be called');
    },
    anthropicHandler: async (_request, response) => {
      upstreamCalled = true;
      response.writeHead(500);
      response.end('should not be called');
    }
  });

  try {
    const response = await fetch(`${stack.localUrl}/v1/models?provider=unsupported`);

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_UPSTREAM_PROVIDER');
    assert.equal(upstreamCalled, false);
  } finally {
    await stack.close();
  }
});

test('single-provider routing keeps routing all allowed paths to configured provider', async () => {
  let upstreamPath;
  let upstreamHeaders;
  const stack = await startStack(
    async (request, response) => {
      upstreamPath = request.url;
      upstreamHeaders = request.headers;
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    },
    { upstreamProvider: 'anthropic', anthropicVersion: '2023-06-01' }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [] })
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamPath, '/v1/chat/completions');
    assert.equal(upstreamHeaders['x-api-key'], 'upstream-token');
    assert.equal(upstreamHeaders['anthropic-version'], '2023-06-01');
    assert.equal(upstreamHeaders.authorization, undefined);
  } finally {
    await stack.close();
  }
});

test('flushes streaming response chunks before upstream completion', async () => {
  const stack = await startStack(async (request, response) => {
    await readRequestBody(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    setTimeout(() => {
      response.end('data: second\n\ndata: [DONE]\n\n');
    }, 100);
  });

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', stream: true, messages: [] })
    });

    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(Buffer.from(first.value).toString(), /data: first/);

    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += Buffer.from(next.value).toString();
    }
    assert.match(rest, /data: second/);
    assert.match(rest, /data: \[DONE\]/);
  } finally {
    await stack.close();
  }
});

test('relays a non-streaming chat completion over required E2EE', async () => {
  let upstreamBody;
  const stack = await startStack(
    async (request, response) => {
      upstreamBody = await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ encrypted: true }));
    },
    { e2ee: true }
  );

  try {
    const body = JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'encrypted prompt' }]
    });
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { encrypted: true });
    assert.equal(upstreamBody.toString(), body);
  } finally {
    await stack.close();
  }
});

test('relays a streaming chat completion over required E2EE', async () => {
  const stack = await startStack(
    async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    },
    { e2ee: true }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'stream encrypted' }]
      })
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /hello/);
    assert.match(body, /\[DONE\]/);
  } finally {
    await stack.close();
  }
});

test('required E2EE hides relay contents from observed WebSocket frames', async () => {
  const observedFrames = [];
  class ObservedWebSocket extends WebSocket {
    constructor(...args) {
      super(...args);
      this.on('message', (data) => observedFrames.push(Buffer.from(data)));
    }

    send(data, options, callback) {
      observedFrames.push(Buffer.from(data));
      return super.send(data, options, callback);
    }
  }

  const stack = await startStack(
    async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json', 'x-sensitive': 'secret-header' });
      response.end(JSON.stringify({ answer: 'secret-response' }));
    },
    { e2ee: true, WebSocketClass: ObservedWebSocket }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-token' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'secret-prompt' }]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { answer: 'secret-response' });
    const transcript = Buffer.concat(observedFrames).toString('utf8');
    assert.doesNotMatch(transcript, /secret-prompt/);
    assert.doesNotMatch(transcript, /client-token/);
    assert.doesNotMatch(transcript, /relay-token/);
    assert.doesNotMatch(transcript, /\/v1\/chat\/completions/);
    assert.doesNotMatch(transcript, /secret-header/);
    assert.doesNotMatch(transcript, /secret-response/);
  } finally {
    await stack.close();
  }
});

test('required E2EE fails for mismatched key material', async () => {
  const stack = await startStack(
    (_request, response) => {
      response.writeHead(500);
      response.end('should not be called');
    },
    { e2ee: true, localE2eePsk: E2EE_OTHER_KEY }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });

    assert.equal(response.status, 502);
  } finally {
    await stack.close();
  }
});

test('required E2EE fails for invalid encrypted relay token', async () => {
  const stack = await startStack(
    (_request, response) => {
      response.writeHead(500);
      response.end('should not be called');
    },
    { e2ee: true, localToken: 'wrong-token' }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });

    assert.equal(response.status, 502);
  } finally {
    await stack.close();
  }
});

test('required remote E2EE rejects plaintext relay messages before handshake', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(500);
    response.end('should not be called');
  });
  const upstreamPort = await listen(upstream);
  const remote = createRemoteRelayServer(
    commonConfig({
      host: '127.0.0.1',
      port: 0,
      relayPath: '/relay',
      relayToken: 'relay-token',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      upstreamApiKey: 'upstream-token',
      relayE2eeMode: REQUIRED_E2EE_MODE,
      relayE2eeKeys: new Map([['main', E2EE_KEY]]),
      relayE2eeHandshakeTimeoutMs: 100
    }),
    { logger }
  );
  const remotePort = await listen(remote);
  const ws = new WebSocket(`ws://127.0.0.1:${remotePort}/relay`);

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(
      encodeJsonMessage({
        type: MESSAGE_TYPES.REQUEST_START,
        id: 'req_plaintext',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {},
        totalBytes: 0
      })
    );
    const close = await new Promise((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    assert.equal(close.code, 1008);
  } finally {
    ws.terminate();
    remote.wss?.clients.forEach((client) => client.terminate());
    await closeServer(remote);
    await closeServer(upstream);
  }
});

test('required E2EE uses the configured remote key selected by local key id', async () => {
  const stack = await startStack(
    async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ rotated: true }));
    },
    {
      e2ee: true,
      relayE2eeKeyId: 'current',
      localE2eePsk: E2EE_OTHER_KEY,
      remoteE2eeKeys: new Map([
        ['old', E2EE_KEY],
        ['current', E2EE_OTHER_KEY]
      ])
    }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rotated: true });
  } finally {
    await stack.close();
  }
});

test('preserves safe upstream error status and body', async () => {
  const stack = await startStack(async (request, response) => {
    await readRequestBody(request);
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: { message: 'rate limited' } });
  } finally {
    await stack.close();
  }
});

test('returns gateway error when relay authentication fails', async () => {
  const stack = await startStack(
    (_request, response) => {
      response.writeHead(500);
      response.end('should not be called');
    },
    { localToken: 'wrong-token' }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'RELAY_UNAVAILABLE');
  } finally {
    await stack.close();
  }
});

test('returns timeout error when upstream request exceeds configured timeout', async () => {
  const stack = await startStack(
    async (request, response) => {
      await readRequestBody(request);
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, 200);
    },
    { requestTimeoutMs: 50, localRequestTimeoutMs: 500 }
  );

  try {
    const response = await fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.code, 'UPSTREAM_TIMEOUT');
  } finally {
    await stack.close();
  }
});

test('returns gateway error when relay is disconnected', async () => {
  const unusedServer = createServer();
  const unusedPort = await listen(unusedServer);
  await closeServer(unusedServer);

  const localConfig = commonConfig({
    host: '127.0.0.1',
    port: 0,
    relayUrl: `ws://127.0.0.1:${unusedPort}/relay`,
    relayToken: 'relay-token',
    connectTimeoutMs: 100
  });
  const relayClient = new RelayClient(localConfig, { logger });
  const local = createLocalProxyServer(localConfig, { relayClient, logger });
  const localPort = await listen(local);

  try {
    const response = await fetch(`http://127.0.0.1:${localPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] })
    });
    assert.equal(response.status, 502);
  } finally {
    await relayClient.close();
    await closeServer(local);
  }
});

test('propagates local cancellation to the upstream request', async () => {
  let upstreamStarted;
  const upstreamStartedPromise = new Promise((resolve) => {
    upstreamStarted = resolve;
  });
  let upstreamClosed;
  const upstreamClosedPromise = new Promise((resolve) => {
    upstreamClosed = resolve;
  });

  const stack = await startStack(async (request, response) => {
    upstreamStarted();
    request.on('close', upstreamClosed);
    await readRequestBody(request);
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }
    }, 500);
  });

  try {
    const controller = new AbortController();
    const responsePromise = fetch(`${stack.localUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'wait' }] }),
      signal: controller.signal
    });

    await upstreamStartedPromise;
    controller.abort();
    await assert.rejects(responsePromise, { name: 'AbortError' });
    await Promise.race([
      upstreamClosedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream did not close')), 500))
    ]);
  } finally {
    await stack.close();
  }
});

test('remote relay rejects digest mismatch over WSS', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(500);
    response.end('should not be called');
  });
  const upstreamPort = await listen(upstream);
  const remote = createRemoteRelayServer(
    commonConfig({
      host: '127.0.0.1',
      port: 0,
      relayPath: '/relay',
      relayToken: 'relay-token',
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      upstreamApiKey: 'upstream-token'
    }),
    { logger }
  );
  const remotePort = await listen(remote);
  const ws = new WebSocket(`ws://127.0.0.1:${remotePort}/relay`, {
    headers: { authorization: 'Bearer relay-token' }
  });

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const payload = Buffer.from('valid payload');
    const [chunk] = splitBuffer(payload, 4096);
    ws.send(
      encodeJsonMessage({
        type: MESSAGE_TYPES.REQUEST_START,
        id: 'req_bad_digest',
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        stream: false,
        encoding: 'identity',
        totalBytes: payload.length
      })
    );
    ws.send(
      encodeChunkMessage(
        { type: MESSAGE_TYPES.REQUEST_CHUNK, id: 'req_bad_digest', seq: 0 },
        chunk
      )
    );
    ws.send(
      encodeJsonMessage({
        type: MESSAGE_TYPES.REQUEST_END,
        id: 'req_bad_digest',
        chunks: 1,
        sha256: sha256Hex('different payload')
      })
    );

    const message = await new Promise((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) resolve(decodeJsonMessage(data));
      });
    });
    assert.equal(message.type, MESSAGE_TYPES.ERROR);
    assert.equal(message.id, 'req_bad_digest');
    assert.equal(message.code, 'DIGEST_MISMATCH');
  } finally {
    ws.terminate();
    remote.wss?.clients.forEach((client) => client.terminate());
    await closeServer(remote);
    await closeServer(upstream);
  }
});
