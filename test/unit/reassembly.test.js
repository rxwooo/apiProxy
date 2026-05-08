import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, splitBuffer } from '../../src/shared/chunking.js';
import { RequestReassembler } from '../../src/shared/reassembly.js';

function makeReassembler(options = {}) {
  return new RequestReassembler({
    maxBytes: 1024,
    maxConcurrent: 2,
    timeoutMs: 1000,
    ...options
  });
}

test('reassembles a complete payload with digest validation', () => {
  const payload = Buffer.from('hello world');
  const chunks = splitBuffer(payload, 5);
  const reassembler = makeReassembler();

  reassembler.start({ id: 'req_1', totalBytes: payload.length });
  chunks.forEach((chunk, seq) => reassembler.addChunk({ id: 'req_1', seq, payload: chunk }));
  const complete = reassembler.finish({
    id: 'req_1',
    chunks: chunks.length,
    sha256: sha256Hex(payload)
  });

  assert.equal(complete.body.toString(), 'hello world');
  assert.equal(reassembler.active.size, 0);
});

test('rejects digest mismatch and releases request state', () => {
  const reassembler = makeReassembler();
  reassembler.start({ id: 'req_1', totalBytes: 3 });
  reassembler.addChunk({ id: 'req_1', seq: 0, payload: Buffer.from('abc') });

  assert.throws(
    () => reassembler.finish({ id: 'req_1', chunks: 1, sha256: sha256Hex('wrong') }),
    /digest mismatch/i
  );
  assert.equal(reassembler.active.size, 0);
});

test('rejects duplicate chunks', () => {
  const reassembler = makeReassembler();
  reassembler.start({ id: 'req_1', totalBytes: 6 });
  reassembler.addChunk({ id: 'req_1', seq: 0, payload: Buffer.from('abc') });

  assert.throws(
    () => reassembler.addChunk({ id: 'req_1', seq: 0, payload: Buffer.from('abc') }),
    /out of order/
  );
  assert.equal(reassembler.active.size, 0);
});

test('rejects out-of-order chunks', () => {
  const reassembler = makeReassembler();
  reassembler.start({ id: 'req_1', totalBytes: 6 });

  assert.throws(
    () => reassembler.addChunk({ id: 'req_1', seq: 1, payload: Buffer.from('abc') }),
    /out of order/
  );
  assert.equal(reassembler.active.size, 0);
});

test('rejects oversized payloads', () => {
  const reassembler = makeReassembler({ maxBytes: 5 });
  reassembler.start({ id: 'req_1', totalBytes: 5 });

  assert.throws(
    () => reassembler.addChunk({ id: 'req_1', seq: 0, payload: Buffer.alloc(6) }),
    /maximum size/
  );
  assert.equal(reassembler.active.size, 0);
});

test('rejects too many concurrent request ids', () => {
  const reassembler = makeReassembler({ maxConcurrent: 1 });
  reassembler.start({ id: 'req_1', totalBytes: 1 });

  assert.throws(
    () => reassembler.start({ id: 'req_2', totalBytes: 1 }),
    /Too many concurrent/
  );
});

test('expires idle request state', () => {
  let now = 1000;
  const reassembler = makeReassembler({ now: () => now, timeoutMs: 100 });
  reassembler.start({ id: 'req_1', totalBytes: 1 });

  now += 101;
  assert.deepEqual(reassembler.cleanupExpired(), ['req_1']);
  assert.equal(reassembler.active.size, 0);
});
