import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_CHUNK_SIZE = 8 * 1024;
export const MAX_SAFE_CHUNK_SIZE = 9 * 1024;

export function createRequestId(prefix = 'req') {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function validateChunkSize(value) {
  const size = Number(value);
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('Chunk size must be a positive integer');
  }
  if (size > MAX_SAFE_CHUNK_SIZE) {
    throw new Error(`Chunk size must be <= ${MAX_SAFE_CHUNK_SIZE} bytes`);
  }
  return size;
}

export function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  if (value == null) return Buffer.alloc(0);
  throw new TypeError('Expected Buffer, Uint8Array, string, or nullish value');
}

export function splitBuffer(value, maxBytes = DEFAULT_CHUNK_SIZE) {
  const buffer = toBuffer(value);
  const chunkSize = validateChunkSize(maxBytes);
  if (buffer.length === 0) return [];

  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

export function sha256Hex(value) {
  return createHash('sha256').update(toBuffer(value)).digest('hex');
}

export function assertSha256(value, expectedDigest) {
  const actual = sha256Hex(value);
  if (actual !== expectedDigest) {
    const error = new Error('Payload digest mismatch');
    error.code = 'DIGEST_MISMATCH';
    error.actual = actual;
    error.expected = expectedDigest;
    throw error;
  }
  return actual;
}
