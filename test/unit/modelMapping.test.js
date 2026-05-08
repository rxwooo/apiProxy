import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelIdMap } from '../../src/shared/config.js';
import {
  applyModelIdMap,
  applyResponseModelIdMap,
  createSseResponseModelMapper
} from '../../src/remote/modelMapping.js';

test('parseModelIdMap accepts an empty mapping', () => {
  assert.deepEqual(parseModelIdMap(''), {});
});

test('parseModelIdMap parses JSON object aliases', () => {
  assert.deepEqual(parseModelIdMap('{"A":"provider-model-id"}'), {
    A: 'provider-model-id'
  });
});

test('parseModelIdMap rejects invalid values', () => {
  assert.throws(() => parseModelIdMap('{'), /valid JSON/);
  assert.throws(() => parseModelIdMap('[]'), /JSON object/);
  assert.throws(() => parseModelIdMap('{"A":""}'), /non-empty strings/);
});

test('applyModelIdMap rewrites top-level model alias only', () => {
  const body = Buffer.from(
    JSON.stringify({
      model: 'A',
      messages: [{ role: 'user', content: 'hello' }]
    })
  );

  const result = applyModelIdMap(body, { A: 'provider-model-id' });
  assert.equal(result.mapped, true);
  assert.equal(result.originalModel, 'A');
  assert.equal(result.mappedModel, 'provider-model-id');
  assert.deepEqual(JSON.parse(result.body.toString()), {
    model: 'provider-model-id',
    messages: [{ role: 'user', content: 'hello' }]
  });
});

test('applyModelIdMap leaves unmapped or invalid payloads unchanged', () => {
  const body = Buffer.from(JSON.stringify({ model: 'B' }));
  assert.equal(applyModelIdMap(body, { A: 'provider-model-id' }).body, body);
  assert.equal(applyModelIdMap(Buffer.from('not json'), { A: 'provider-model-id' }).mapped, false);
});

test('applyResponseModelIdMap rewrites upstream model id back to client alias', () => {
  const body = Buffer.from(
    JSON.stringify({
      id: 'chatcmpl_test',
      model: 'provider-model-id'
    })
  );

  const result = applyResponseModelIdMap(body, {
    mapped: true,
    originalModel: 'A',
    mappedModel: 'provider-model-id'
  });

  assert.equal(result.mapped, true);
  assert.deepEqual(JSON.parse(result.body.toString()), {
    id: 'chatcmpl_test',
    model: 'A'
  });
});

test('applyResponseModelIdMap leaves unrelated response models unchanged', () => {
  const body = Buffer.from(JSON.stringify({ model: 'other-model' }));
  const result = applyResponseModelIdMap(body, {
    mapped: true,
    originalModel: 'A',
    mappedModel: 'provider-model-id'
  });
  assert.equal(result.body, body);
  assert.equal(result.mapped, false);
});

test('createSseResponseModelMapper rewrites model ids in SSE data lines', () => {
  const mapper = createSseResponseModelMapper({
    mapped: true,
    originalModel: 'A',
    mappedModel: 'provider-model-id'
  });

  const output = Buffer.concat([
    ...mapper.push(
      Buffer.from('data: {"id":"chunk_1","model":"provider-model-id","choices":[]}\n')
    ),
    ...mapper.push(Buffer.from('data: [DONE]\n\n')),
    ...mapper.flush()
  ]).toString('utf8');

  assert.equal(output, 'data: {"id":"chunk_1","model":"A","choices":[]}\ndata: [DONE]\n\n');
});
