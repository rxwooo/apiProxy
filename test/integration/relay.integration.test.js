import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { splitBuffer, sha256Hex } from '../../src/shared/chunking.js';
import { createLogger } from '../../src/shared/logger.js';
import {
  MESSAGE_TYPES,
  decodeJsonMessage,
  encodeChunkMessage,
  encodeJsonMessage
} from '../../src/shared/protocol.js';
import { RelayClient } from '../../src/local/relayClient.js';
import { createLocalProxyServer } from '../../src/local/server.js';
import { createRemoteRelayServer } from '../../src/remote/server.js';

const logger = createLogger({ level: 'silent' });

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

  const remoteConfig = commonConfig({
    host: '127.0.0.1',
    port: 0,
    relayPath: '/relay',
    relayToken: overrides.remoteToken ?? 'relay-token',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamApiKey: 'upstream-token',
    upstreamAuthScheme: 'Bearer',
    modelIdMap: overrides.modelIdMap ?? {},
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1000
  });
  const remote = createRemoteRelayServer(remoteConfig, { logger });
  const remotePort = await listen(remote);

  const localConfig = commonConfig({
    host: '127.0.0.1',
    port: 0,
    relayUrl: `ws://127.0.0.1:${remotePort}/relay`,
    relayToken: overrides.localToken ?? 'relay-token',
    requestTimeoutMs: overrides.localRequestTimeoutMs ?? overrides.requestTimeoutMs ?? 1000
  });
  const relayClient = new RelayClient(localConfig, { logger });
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
    assert.equal(body.error.code, 'RELAY_ERROR');
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
