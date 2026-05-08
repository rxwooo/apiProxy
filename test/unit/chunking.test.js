import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequestId,
  sha256Hex,
  splitBuffer,
  validateChunkSize
} from '../../src/shared/chunking.js';
import {
  MESSAGE_TYPES,
  decodeChunkMessage,
  decodeJsonMessage,
  encodeChunkMessage,
  encodeJsonMessage
} from '../../src/shared/protocol.js';

test('splitBuffer keeps every chunk within the configured boundary', () => {
  const payload = Buffer.alloc(10_241, 'a');
  const chunks = splitBuffer(payload, 4096);

  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [4096, 4096, 2049]
  );
  assert.equal(Buffer.concat(chunks).compare(payload), 0);
});

test('splitBuffer returns no chunks for an empty payload', () => {
  assert.deepEqual(splitBuffer(Buffer.alloc(0), 4096), []);
});

test('validateChunkSize rejects unsafe values', () => {
  assert.throws(() => validateChunkSize(0), /positive integer/);
  assert.throws(() => validateChunkSize(10 * 1024), /<=/);
});

test('sha256Hex is stable for equal payloads', () => {
  assert.equal(sha256Hex('hello'), sha256Hex(Buffer.from('hello')));
  assert.notEqual(sha256Hex('hello'), sha256Hex('world'));
});

test('createRequestId creates stable prefixed ids', () => {
  const id = createRequestId('test');
  assert.match(id, /^test_[a-f0-9]{32}$/);
});

test('JSON protocol messages round-trip with version validation', () => {
  const decoded = decodeJsonMessage(
    encodeJsonMessage({ type: MESSAGE_TYPES.REQUEST_CANCEL, id: 'req_1' })
  );
  assert.equal(decoded.version, 1);
  assert.equal(decoded.type, MESSAGE_TYPES.REQUEST_CANCEL);
  assert.equal(decoded.id, 'req_1');
});

test('binary chunk protocol frame round-trips payload and envelope', () => {
  const frame = encodeChunkMessage(
    { type: MESSAGE_TYPES.REQUEST_CHUNK, id: 'req_1', seq: 7 },
    Buffer.from('payload')
  );
  const decoded = decodeChunkMessage(frame);
  assert.equal(decoded.header.type, MESSAGE_TYPES.REQUEST_CHUNK);
  assert.equal(decoded.header.id, 'req_1');
  assert.equal(decoded.header.seq, 7);
  assert.equal(decoded.payload.toString(), 'payload');
});
