import { assertSha256 } from './chunking.js';

export class ReassemblyError extends Error {
  constructor(message, { code = 'REASSEMBLY_ERROR', status = 400 } = {}) {
    super(message);
    this.name = 'ReassemblyError';
    this.code = code;
    this.status = status;
  }
}

export class RequestReassembler {
  constructor({ maxBytes, maxConcurrent, timeoutMs, now = () => Date.now() }) {
    this.maxBytes = maxBytes;
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.active = new Map();
  }

  start(metadata) {
    this.cleanupExpired();
    if (!metadata?.id) {
      throw new ReassemblyError('Request metadata is missing id', { code: 'MISSING_ID' });
    }
    if (this.active.has(metadata.id)) {
      throw new ReassemblyError('Request id is already active', { code: 'DUPLICATE_REQUEST' });
    }
    if (this.active.size >= this.maxConcurrent) {
      throw new ReassemblyError('Too many concurrent relayed requests', {
        code: 'TOO_MANY_REQUESTS',
        status: 429
      });
    }
    if (metadata.totalBytes > this.maxBytes) {
      throw new ReassemblyError('Request exceeds configured maximum size', {
        code: 'REQUEST_TOO_LARGE',
        status: 413
      });
    }

    const now = this.now();
    this.active.set(metadata.id, {
      metadata,
      chunks: [],
      bytes: 0,
      nextSeq: 0,
      startedAt: now,
      updatedAt: now
    });
  }

  addChunk({ id, seq, payload }) {
    this.cleanupExpired();
    const state = this.#state(id);
    if (seq !== state.nextSeq) {
      this.active.delete(id);
      throw new ReassemblyError('Request chunk sequence is out of order', {
        code: 'CHUNK_ORDER'
      });
    }

    const bytes = Buffer.from(payload);
    if (state.bytes + bytes.length > this.maxBytes) {
      this.active.delete(id);
      throw new ReassemblyError('Request exceeds configured maximum size', {
        code: 'REQUEST_TOO_LARGE',
        status: 413
      });
    }

    state.chunks.push(bytes);
    state.bytes += bytes.length;
    state.nextSeq += 1;
    state.updatedAt = this.now();
  }

  finish({ id, chunks, sha256 }) {
    this.cleanupExpired();
    const state = this.#state(id);
    if (chunks !== state.nextSeq) {
      this.active.delete(id);
      throw new ReassemblyError('Request chunk count does not match received chunks', {
        code: 'INCOMPLETE_REQUEST'
      });
    }
    if (state.metadata.totalBytes !== undefined && state.metadata.totalBytes !== state.bytes) {
      this.active.delete(id);
      throw new ReassemblyError('Request byte count does not match metadata', {
        code: 'BYTE_COUNT_MISMATCH'
      });
    }

    const body = Buffer.concat(state.chunks, state.bytes);
    try {
      assertSha256(body, sha256);
    } catch (error) {
      this.active.delete(id);
      throw new ReassemblyError('Payload digest mismatch', {
        code: error.code ?? 'DIGEST_MISMATCH'
      });
    }

    this.active.delete(id);
    return {
      metadata: state.metadata,
      body,
      digest: sha256
    };
  }

  abort(id) {
    return this.active.delete(id);
  }

  abortAll() {
    const count = this.active.size;
    this.active.clear();
    return count;
  }

  cleanupExpired(now = this.now()) {
    const expired = [];
    for (const [id, state] of this.active.entries()) {
      if (now - state.updatedAt >= this.timeoutMs) {
        this.active.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }

  #state(id) {
    const state = this.active.get(id);
    if (!state) {
      throw new ReassemblyError('Unknown or expired request id', { code: 'UNKNOWN_REQUEST' });
    }
    return state;
  }
}
