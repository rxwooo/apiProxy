const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const SENSITIVE_FORWARD_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

export async function readRequestBody(request, { maxBytes }) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error('Request body exceeds configured maximum');
      error.code = 'REQUEST_TOO_LARGE';
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function normalizeIncomingHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return normalized;
}

export function selectForwardHeaders(headers) {
  const normalized = normalizeIncomingHeaders(headers);
  const selected = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (SENSITIVE_FORWARD_HEADERS.has(key)) continue;
    selected[key] = value;
  }
  return selected;
}

export function filterResponseHeaders(headers) {
  const entries =
    typeof headers?.entries === 'function' ? headers.entries() : Object.entries(headers ?? {});
  const filtered = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === 'set-cookie') continue;
    filtered[key] = String(rawValue);
  }
  return filtered;
}

export function sendJson(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...headers
  });
  response.end(body);
}

export function isStreamingHeaders(headers = {}) {
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  return contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson');
}

export function parseJsonBody(buffer) {
  if (!buffer.length) return undefined;
  return JSON.parse(buffer.toString('utf8'));
}
